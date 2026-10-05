// What's kept in settings.json and what's trusted to act unasked: loading and
// saving the list, the signed approvals, and the confirmation window. Mixed
// into WorkflowService (service.js); `this` is the service.
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { validateWorkflow, describeTrigger, capabilities, riskSignature, riskDetail, walkSteps } = require('./schema');
const { clean } = require('./util');

const MAX_CONFIRM_DETAIL = 12000;  // what the confirmation window shows in full
const MODE_NAMES = { ask: 'Ask first', smart: 'Smart', acceptEdits: 'Auto-edit', plan: 'Plan only', autonomous: 'Autonomous' };

class Approvals {
  /**
   * What's in settings.json, checked again: it's a file anything on this PC
   * can write. A workflow that no longer validates is kept as it was (never
   * run, never lost). One that can act unasked must carry the approval Shellby
   * signed when you said yes to it; without one it's paused until you save it
   * again, which asks.
   */
  loadWorkflows() {
    const raw = this.deps.config.get('workflows');
    const out = [];
    this.broken = [];
    for (const w of Array.isArray(raw) ? raw : []) {
      const r = validateWorkflow(w, { allowAutonomous: this.deps.allowAutonomous(), now: w?.updatedAt || this.now() });
      if (!r.ok) {
        this.broken.push(w);
        this.deps.log.warn(`workflow "${clean(w?.name).slice(0, 60)}" not loaded: ${r.errors.map(e => e.message).join('; ')}`);
        continue;
      }
      const wf = { ...r.workflow, updatedAt: w.updatedAt || r.workflow.updatedAt };
      if (wf.enabled && !this.approved(wf)) {
        wf.enabled = false;
        wf.needsApproval = true;
        this.deps.log.warn(`workflow "${wf.name}" paused: what it may do was never approved here`);
      }
      out.push(wf);
    }
    return out;
  }

  persist(list) {
    this.workflows = list;
    this.deps.config.set({ workflows: [...list.map(({ needsApproval: _flag, ...w }) => w), ...this.broken] });
    this.folders.sync(list);
    this.pushView();
  }

  // ---- approvals: an HMAC of each workflow's risk signature, under a key
  // kept encrypted by Windows. A risky workflow written into settings.json by
  // anything other than Shellby's own Save has no valid one.
  approvalKey() {
    if (this.key !== undefined) return this.key;
    const file = path.join(this.deps.dataDir, 'approval.key');
    this.key = null;
    try {
      if (!this.deps.crypto.available()) return this.key;
      if (fs.existsSync(file)) this.key = Buffer.from(this.deps.crypto.decrypt(fs.readFileSync(file)), 'hex');
      else {
        const key = crypto.randomBytes(32);
        fs.mkdirSync(this.deps.dataDir, { recursive: true });
        fs.writeFileSync(file, this.deps.crypto.encrypt(key.toString('hex')));
        this.key = key;
      }
    } catch (e) {
      this.deps.log.warn(`workflow approvals unavailable: ${e.message}`);
    }
    return this.key;
  }

  sign(wf) {
    const key = this.approvalKey();
    return key ? crypto.createHmac('sha256', key).update(`${wf.id}\n${riskSignature(wf)}`).digest('hex') : null;
  }

  approved(wf) {
    if (!riskSignature(wf)) return true;
    const want = this.sign(wf);
    const have = (this.deps.config.get('workflowApprovals') || {})[wf.id];
    // No key (Windows' encrypted storage is unavailable): nothing can be
    // checked, so nothing that acts unasked is trusted. It fails closed.
    if (!want) return false;
    return typeof have === 'string' && have.length === want.length && crypto.timingSafeEqual(Buffer.from(have), Buffer.from(want));
  }

  approve(wf) {
    const all = { ...(this.deps.config.get('workflowApprovals') || {}) };
    const sig = riskSignature(wf) ? this.sign(wf) : null;
    if (sig) all[wf.id] = sig; else delete all[wf.id];
    for (const id of Object.keys(all)) if (id !== wf.id && !this.workflows.some(w => w.id === id)) delete all[id];
    this.deps.config.set({ workflowApprovals: all });
  }

  /**
   * What the confirm window would say about saving this, without asking:
   * { ok, detail } | { ok: false, errors }. For a team pack's "Set it all up",
   * which shows it alongside the rest of the pack in one window.
   */
  saveDetail(input, { source = 'team' } = {}) {
    const existing = input && typeof input === 'object' && input.id ? this.get(input.id) : null;
    const r = validateWorkflow({ ...input, createdAt: existing?.createdAt ?? input?.createdAt }, { allowAutonomous: this.deps.allowAutonomous(), now: this.now() });
    if (!r.ok) return { ok: false, errors: r.errors };
    return { ok: true, detail: this.confirmText(r.workflow, existing, source).detail };
  }

  confirmText(wf, existing, source) {
    const auto = JSON.stringify(wf.steps).includes('"mode":"autonomous"');
    const triggers = wf.when.length ? wf.when.map(describeTrigger) : ['Only when you run it'];
    const steps = [];
    walkSteps(wf.steps, (s, _at, scope) => steps.push(`${'  '.repeat(scope.length)}${s.label || s.id} (${s.type}${s.mode ? `, ${MODE_NAMES[s.mode]}` : ''})`));
    const risky = riskDetail(wf);
    const who = source === 'claude' ? (existing ? 'Claude wants to change' : 'Claude wants to add')
      : source === 'team' ? (existing ? "The repo's team pack has a different version of" : "From the repo's team pack:") : 'Save';
    const caps = capabilities(wf);
    const detail = [
      `Starts: ${triggers.join('; ')}`,
      caps.length ? `\nWithout asking first, it can:\n${caps.map(c => `• ${c}`).join('\n')}` : '',
      `\nSteps:\n${steps.join('\n')}`,
      risky ? `\nIn full:\n\n${risky}` : '\nIt only looks and reports, or asks you before it acts.',
    ].filter(Boolean).join('\n');
    return { auto, who, detail };
  }

  async confirmSave(wf, existing, source) {
    const { auto, who, detail } = this.confirmText(wf, existing, source);
    // A proposal too long to show in full is refused, never shortened: the
    // part left off is the part that could hide something.
    if (detail.length > MAX_CONFIRM_DETAIL && source !== 'panel') return 'too-long';
    const answer = await this.deps.confirm({
      icon: '⚡', danger: auto,
      title: existing ? 'Change a workflow?' : 'Add a workflow?',
      message: `${who} "${wf.name}".`,
      detail: detail.length > MAX_CONFIRM_DETAIL ? `${detail.slice(0, MAX_CONFIRM_DETAIL)}\n\n… it goes on: read the rest in the editor before saving.` : detail,
      note: 'Claude steps run on your Claude subscription. You can pause, edit or delete it on the Automate page.',
      buttons: [{ label: existing ? 'Save changes' : 'Add workflow', style: auto ? 'danger' : 'primary' }, { label: 'Cancel' }],
      defaultId: 1, cancelId: 1,
    });
    return answer === 0 ? 'yes' : 'no';
  }
}

module.exports = { Approvals, MAX_CONFIRM_DETAIL };
