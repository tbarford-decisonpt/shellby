// A conversation feed's words and decisions (feed.js and the files beside it
// draw them): the one-line marks Shellby leaves in a feed, a turn's result
// line, permission and question verdicts, a diff's lines, branch notes and a
// helper lane's meta. Pure, no DOM. Works in the browser and in Node (for tests).
(function (root) {
  const files = n => `${n} file${n === 1 ? '' : 's'}`;
  const commits = n => `${n} commit${n === 1 ? '' : 's'}`;

  // ------------------------------------------------------------ marks

  // The notes Shellby leaves in a feed that are a glyph and a line: { icon, text },
  // or null for any other kind. compact: SB.compact, for token counts.
  function markFor(item, compact) {
    switch (item.kind) {
      case 'moved':
        return { icon: '⑂', text: `Moved into its own copy before changing anything: branch ${item.branch} (from ${item.base})` };
      case 'phone':
        return { icon: '📱', text: 'Started from your phone, in Ask first: he asks before he changes anything' };
      case 'home':
        return { icon: '↩', text: `Brought home: ${commits(item.commits)} merged into ${item.base}` };
      case 'home-wait':
        return { icon: '⋯', text: `Waiting its turn: another copy is coming home into ${item.base} first` };
      case 'pushed':
        return { icon: '⇡', text: `Pushed ${item.branch} to ${item.remote}: ${commits(item.commits)}${item.pulled ? `, after taking in ${item.pulled} from ${item.remote}` : ''}` };
      case 'compacted':
        return { icon: '⇣', text: `${item.trigger === 'auto' ? 'Claude Code compacted the conversation to make room' : 'Compacted the conversation'}${item.preTokens ? ` (it was ${compact(item.preTokens)} tokens)` : ''}` };
      case 'fresh':
        return { icon: '↻', text: 'Started fresh: a new conversation picks up from the summary above' };
      case 'rewound':
        return {
          icon: '↶',
          text: item.conversation === false ? `Rewound the code: put ${files(item.restored || 0)} back`
            : `Rewound to an earlier message${item.code && item.restored ? `, and put ${files(item.restored)} back` : ''}`,
        };
      default:
        return null;
    }
  }

  // The note at the top of a feed that has dropped its oldest blocks.
  const trimmedLine = n => `${n.toLocaleString()} earlier ${n === 1 ? 'step' : 'steps'} hidden — the full conversation is in History.`;

  // ------------------------------------------------------------ handoff and branches

  const SHELLS = { wt: 'Windows Terminal', powershell: 'PowerShell', cmd: 'Command Prompt' };
  const shellName = id => SHELLS[id] || 'a terminal';

  // At the top of a branch: where it split off, and what it has for files.
  function branchedFrom(item) {
    const where = item.at === 'after' ? `after its reply to "${item.text}"` : `just before "${item.text}"`;
    const what = item.shared ? 'It shares the original\'s folder, so changes either makes, the other sees.'
      : item.filesNow ? `Its own copy on ${item.branch}, with the files as they were in the original when it branched.`
        : item.branch ? `Its own copy on ${item.branch}, with the files exactly as they were then${item.approx ? ' (as near as Shellby can tell)' : ''}.`
          : '';
    return { where, files: what };
  }

  // In the original: where its branch split off.
  const branchedOffWhere = item => (item.at === 'after' ? `from after the reply to "${item.text}"` : `from just before "${item.text}"`);

  // Two tries side by side: the comparison's heading.
  const compareHead = (otherTitle, r) => (r.same ? `Same files as "${otherTitle}"` : `${files(r.files.length + (r.more || 0))} differ from "${otherTitle}"`);

  // ------------------------------------------------------------ permission cards

  // The "always" button for Claude Code's first suggestion.
  function suggestionLabel(s) {
    if (s?.type === 'setMode') return s.mode === 'acceptEdits' ? 'Allow all edits' : `Switch to ${s.mode}`;
    if (s?.type === 'addRules' && s.rules?.[0]) {
      const r = s.rules[0];
      return r.ruleContent ? `Always allow ${r.toolName}(${r.ruleContent.length > 24 ? r.ruleContent.slice(0, 22) + '…' : r.ruleContent})` : `Always allow ${r.toolName}`;
    }
    if (s?.type === 'addDirectories') return 'Always allow this folder';
    return 'Always allow';
  }

  // The mode chip after a plan is approved: what Claude Code switches to, as
  // the panel names it (null: autonomous, which the chip never picks by itself).
  function modeAfterPlan(suggestions) {
    const next = suggestions?.find(s => s.type === 'setMode')?.mode;
    return next === 'acceptEdits' ? 'acceptEdits' : next === 'bypassPermissions' ? null : 'ask';
  }

  const DECISION_WORDS = { allow: 'Allowed', always: 'Always allowed', deny: 'Denied', cancelled: 'Cancelled' };
  const VIA_WORDS = { phone: ' from your phone', deck: ' from the Stream Deck' };

  // A decided permission card: { text, tone } with tone 'allow' or 'deny'.
  function decisionVerdict(decision, via) {
    return {
      text: `→ ${DECISION_WORDS[decision] || decision}${VIA_WORDS[via] || ''}`,
      tone: decision === 'deny' || decision === 'cancelled' ? 'deny' : 'allow',
    };
  }

  // A decided question: what was answered, instead of "Allowed".
  function questionVerdict(decision, answers) {
    const a = answers ? Object.values(answers).join(' · ') : null;
    const text = decision === 'cancelled' ? '→ Not answered' : a ? `→ ${a}` : decision === 'deny' ? '→ Skipped' : '→ Answered';
    return { text, tone: a ? 'allow' : 'deny' };
  }

  // ------------------------------------------------------------ a turn's end

  // The line under a turn: { label, waiting }, waiting being what it left running.
  function resultLabel(item) {
    const waiting = item.ok && !item.interrupted && item.waiting?.length
      ? `waiting on ${item.waiting.length === 1 ? item.waiting[0] : `${item.waiting.length} background tasks`}`
      : null;
    return { label: item.interrupted ? 'stopped' : waiting || (item.ok ? 'done' : 'ended with an error'), waiting };
  }

  // ------------------------------------------------------------ diffs

  const MAX_DIFF_LINES = 4000;
  const HEADER = /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index)/;

  // A unified diff as [{ cls, text }], file headers left out: cls is hunk, add,
  // del, meta or ctx. At most four thousand lines.
  function diffRows(patch) {
    const lines = String(patch || '').replace(/\n$/, '').split('\n');
    const rows = [];
    let inHeader = true; // a removed "-- note" inside a hunk is "--- note", and that's code
    for (const line of lines) {
      if (rows.length >= MAX_DIFF_LINES) break;
      if (line.startsWith('diff --git')) inHeader = true;
      if (inHeader && HEADER.test(line)) continue;
      if (line.startsWith('@@')) inHeader = false;
      const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('\\') ? 'meta' : 'ctx';
      rows.push({ cls, text: line || ' ' });
    }
    return rows;
  }

  // ------------------------------------------------------------ crew lanes

  // A helper lane's meta: tools used, tokens, how long. compact and duration: SB's.
  function laneMeta(stats, ms, { compact, duration }) {
    const bits = [];
    if (stats?.toolUses) bits.push(`${stats.toolUses} tool${stats.toolUses > 1 ? 's' : ''}`);
    if (stats?.tokens) bits.push(`${compact(stats.tokens)} tok`);
    bits.push(duration(ms));
    return bits.join(' · ');
  }

  // A finished helper's summary, as the one line its lane shows.
  function laneFirstLine(text) {
    const first = text.replace(/[#*`_>]/g, '').split('\n').find(l => l.trim());
    return first ? first.trim().slice(0, 120) : null;
  }

  const api = {
    files, markFor, trimmedLine, shellName, branchedFrom, branchedOffWhere, compareHead, suggestionLabel, modeAfterPlan,
    decisionVerdict, questionVerdict, resultLabel, diffRows, laneMeta, laneFirstLine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyFeedLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
