/* Shellby panel — Workflows: the editor's field builders. */
'use strict';
(function () {
  const { h, api, state } = SB;
  const W = SB.wfKit;
  const {
    uid, slots, changed, toInt, workflows, ed, fill, iconBtn, TRIGGER_FIELDS, walk, STEP_OUTPUTS, STEP_INFO,
    popup, menuLabel, menuItem,
  } = W;

  // ================================================================ the editor: field builders

  function slot(at, control) {
    const err = h('p', { class: 'wf-err', id: uid('err'), hidden: true });
    if (at) slots.set(at, { err, control });
    if (control) control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), err.id].filter(Boolean).join(' '));
    return err;
  }

  function wrap(labelText, control, { at, hint, insert, cls = '' } = {}) {
    if (!control.id) control.id = uid('f');
    let hintEl = null;
    if (hint) {
      hintEl = h('p', { class: 'field-hint', id: uid('hint'), text: hint });
      control.setAttribute('aria-describedby', hintEl.id);
    }
    const err = slot(at, control);
    const body = insert ? h('div', { class: 'wf-with-insert' }, control, insertBtn(control, insert, labelText)) : control;
    return h('div', { class: `wf-field ${cls}` }, h('label', { class: 'field-label', for: control.id, text: labelText }), body, hintEl, err);
  }

  function textControl(tag, value, onChange, attrs = {}) {
    const el = h(tag, { class: tag === 'textarea' ? 'field area' : 'field', autocomplete: 'off', spellcheck: 'false', ...(tag === 'input' ? { type: 'text' } : {}), ...attrs });
    el.value = value ?? '';
    el.addEventListener('input', () => { onChange(el.value); changed(); });
    return el;
  }
  const txt = (label, value, onChange, opts = {}) => wrap(label, textControl('input', value, onChange, opts.attrs), opts);
  const area = (label, value, onChange, opts = {}) => wrap(label, textControl('textarea', value, onChange, { rows: 3, ...opts.attrs }), opts);

  // Chromium turns the wheel over a focused number box into +1/-1, so scrolling
  // the page past one quietly changes it. Let go of the box and let the page scroll.
  function noWheel(el) {
    el.addEventListener('wheel', () => { if (document.activeElement === el) el.blur(); }, { passive: true });
    return el;
  }

  function num(label, value, onChange, opts = {}) {
    const el = noWheel(h('input', { class: 'field', type: 'number', inputmode: 'numeric', ...opts.attrs }));
    el.value = value ?? '';
    el.addEventListener('input', () => { onChange(toInt(el.value)); changed(); });
    return wrap(label, el, opts);
  }

  // options: [[value, label, disabled?]] or [{ group, options }]
  function selectControl(options, value, onChange, attrs = {}) {
    const opt = ([v, l, dis]) => h('option', { value: v, text: l, disabled: !!dis });
    const el = h('select', { class: 'field', ...attrs },
      options.map(o => (Array.isArray(o) ? opt(o) : h('optgroup', { label: o.group }, o.options.map(opt)))));
    el.value = value ?? '';
    el.addEventListener('change', () => { onChange(el.value); changed(); });
    return el;
  }
  const sel = (label, options, value, onChange, opts = {}) => wrap(label, selectControl(options, value, onChange, opts.attrs), opts);

  // Another workflow, by name (a "workflow" trigger or step).
  function workflowPicker(label, value, onChange, opts) {
    const others = workflows().filter(w => w.id !== ed.def.id).map(w => w.name);
    const options = [['', others.length ? 'Pick one…' : 'No other workflows yet'], ...others.map(n => [n, n])];
    if (value && !others.includes(value)) options.push([value, `${value} (not found)`]);
    return sel(label, options, value || '', onChange, opts);
  }

  function check(label, checked, onChange, { hint, at } = {}) {
    const input = h('input', { type: 'checkbox', checked: !!checked, onchange: e => { onChange(e.target.checked); changed(); } });
    const hintEl = hint ? h('span', { class: 'field-hint', text: hint }) : null;
    return h('div', { class: 'wf-field' },
      h('label', { class: 'wf-check' }, input, h('span', {}, h('span', { text: label }), hintEl)),
      at ? slot(at, input) : null);
  }

  function folderField(label, value, onChange, { at, placeholder, hint } = {}) {
    const input = textControl('input', value, onChange, { placeholder });
    input.id = uid('dir');
    const choose = h('button', {
      type: 'button', class: 'btn slim-btn', 'aria-label': `Choose a folder for ${label.toLowerCase()}`,
      onclick: async () => {
        const dir = await api.pickAnyFolder();
        if (!dir) return;
        input.value = dir;
        onChange(dir);
        changed();
      },
    }, 'Choose…');
    const clear = h('button', {
      type: 'button', class: 'btn ghost slim-btn', 'aria-label': `Clear ${label.toLowerCase()}`,
      onclick: () => { input.value = ''; onChange(''); changed(); input.focus(); },
    }, 'Clear');
    const hintEl = hint ? h('p', { class: 'field-hint', id: uid('hint'), text: hint }) : null;
    if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
    const err = slot(at, input);
    return h('div', { class: 'wf-field' },
      h('label', { class: 'field-label', for: input.id, text: label }),
      h('div', { class: 'wf-folder' }, input, choose, clear), hintEl, err);
  }

  // A list of rows (inputs, headers, values, output fields…). Rows live in a
  // local array; every edit hands the whole list back through onChange.
  function rowsEditor({ legend, rows, columns, onChange, at, addText, hint, max = 20, blank }) {
    const box = h('div', { class: 'wf-rows' });
    const addBtn = h('button', { type: 'button', class: 'btn ghost slim-btn wf-add-row', onclick: () => { rows.push(blank()); emit(); draw(rows.length - 1); } }, `+ ${addText}`);
    const emit = () => { onChange(rows); changed(); addBtn.disabled = rows.length >= max; };
    function draw(focusRow = -1) {
      fill(box, ...rows.map((r, i) => rowEl(r, i)));
      addBtn.disabled = rows.length >= max;
      if (focusRow >= 0) box.children[focusRow]?.querySelector('input, select')?.focus();
    }
    function rowEl(r, i) {
      const cells = columns.map(c => cell(c, r, i));
      return h('div', { class: 'wf-row-edit', style: `--cols: ${columns.map(c => c.width || '1fr').join(' ')} auto` }, cells,
        iconBtn('close', `Remove ${(r[columns[0].key] || `row ${i + 1}`)}`, () => { rows.splice(i, 1); emit(); draw(); (box.children[Math.min(i, rows.length - 1)]?.querySelector('input') || addBtn).focus(); }));
    }
    function cell(c, r, i) {
      const label = `${c.label} ${i + 1}`;
      if (c.kind === 'check') {
        return h('label', { class: 'wf-check small' }, h('input', { type: 'checkbox', checked: !!r[c.key], onchange: e => { r[c.key] = e.target.checked; emit(); } }), h('span', { text: c.label }));
      }
      if (c.kind === 'select') {
        return h('select', { class: 'field', 'aria-label': label, onchange: e => { r[c.key] = e.target.value; emit(); } },
          c.options.map(o => h('option', { value: o, text: o, selected: r[c.key] === o })));
      }
      const input = h('input', { class: `field${c.mono ? ' wf-mono' : ''}`, type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': label, placeholder: c.placeholder || '', oninput: e => { r[c.key] = e.target.value; emit(); } });
      input.value = r[c.key] ?? '';
      return c.insert ? h('div', { class: 'wf-with-insert' }, input, insertBtn(input, c.insert, label)) : input;
    }
    draw();
    const legendId = uid('lg');
    const hintEl = hint ? h('p', { class: 'field-hint', text: hint }) : null;
    return h('div', { class: 'wf-field', role: 'group', 'aria-labelledby': legendId },
      h('div', { class: 'field-label', id: legendId, text: legend }), hintEl, box, addBtn, slot(at, null));
  }

  // { name: value } <-> rows
  const objRows = obj => Object.entries(obj || {}).map(([k, v]) => ({ k, v: typeof v === 'string' ? v : JSON.stringify(v) }));
  const rowsObj = rows => Object.fromEntries(rows.filter(r => String(r.k || '').trim()).map(r => [r.k.trim(), r.v ?? '']));

  // ================================================================ the editor: insert value

  // What a templated field can refer to from where it sits: the trigger's
  // data, inputs, earlier steps' outputs, values set earlier, the loop it's in.
  function refsAt(ctx, { secrets }) {
    const groups = [];
    const d = ed.def;
    const add = (title, items) => { if (items.length) groups.push({ title, items }); };

    const trig = [];
    const seen = new Set();
    for (const t of d.when) {
      if (t.type === 'webhook' && !seen.has('webhook')) trig.push({ path: 'trigger.', sub: 'Any field of the JSON a script sends', partial: true });
      for (const [f, sub] of Object.entries(TRIGGER_FIELDS[t.type] || {})) {
        if (seen.has(`trigger.${f}`)) continue;
        seen.add(`trigger.${f}`);
        trig.push({ path: `trigger.${f}`, sub });
      }
      seen.add(t.type);
    }
    add('What started it', trig);
    add('Inputs', d.inputs.filter(i => i.name).map(i => ({ path: `inputs.${i.name}`, sub: i.label || '' })));

    const earlier = [];
    if (ctx) for (const { list: l, index } of ctx.chain) walk(l.slice(0, index), s => earlier.push(s));
    const outs = [];
    const vars = [];
    for (const s of earlier) {
      if (!s.id) continue;
      const fields = STEP_OUTPUTS[s.type]?.(s) || {};
      const who = s.label || STEP_INFO[s.type]?.name;
      for (const [f, sub] of Object.entries(fields)) outs.push({ path: `${s.id}.${f}`, sub: `${who}: ${sub}` });
      if (s.type === 'set') for (const k of Object.keys(s.values || {})) vars.push({ path: `vars.${k}`, sub: who });
    }
    add('Earlier steps', outs);
    add('Values', vars);

    const loops = [];
    if (ctx) {
      for (const { list: l, index } of ctx.chain.slice(0, -1)) {
        const a = l[index];
        if (a?.type === 'each') loops.push({ path: a.as || 'item', sub: 'This item' });
      }
      if (loops.length) loops.push({ path: 'loop.index', sub: 'Its position, from 0' }, { path: 'loop.number', sub: 'Its position, from 1' });
    }
    add('This loop', loops);
    add('Run', [{ path: 'now', sub: 'The date and time' }, { path: 'today', sub: 'Today, like 2026-10-03' }, { path: 'run.id', sub: 'This run' }]);
    if (secrets) add('Secrets', (state.workflows?.secrets || []).map(n => ({ path: `secrets.${n}`, sub: 'Kept out of the run\'s record' })));
    return groups;
  }

  function insertBtn(control, opts, labelText) {
    const btn = h('button', {
      type: 'button', class: 'icon-btn wf-insert', title: 'Insert a value', 'aria-label': `Insert a value into ${labelText}`,
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: () => popup(btn, () => {
        const groups = refsAt(opts.ctx, opts);
        if (!groups.length) return [menuLabel('Nothing to insert here yet')];
        return groups.flatMap(g => [menuLabel(g.title), ...g.items.map(it => menuItem(it.path, it.sub, () => insertRef(control, it, opts.cond), { mono: true }))]);
      }),
    }, h('span', { class: 'wf-braces', 'aria-hidden': 'true', text: '{ }' }));
    return btn;
  }

  function insertRef(control, item, cond) {
    const text = cond ? item.path : `{{ ${item.path} }}`;
    control.focus();
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? start;
    control.setRangeText(text, start, end, 'end');
    if (item.partial && !cond) { const p = control.selectionEnd - 3; control.setSelectionRange(p, p); }
    control.dispatchEvent(new Event('input', { bubbles: true }));
  }

  Object.assign(W, {
    area, sel, folderField, check, slot, txt, rowsEditor, objRows, rowsObj, num, workflowPicker, noWheel,
    selectControl, wrap,
  });
})();
