/* Shellby panel — picking MCP servers for a workflow's Claude step or a
   routine: which servers' tools Claude may use without asking, and whether
   they're the only ones it loads (mcpservers.js on the main side). Both
   editors use it. Server names are untrusted text and only reach the page
   through SB.h. */
'use strict';
(function () {
  const { h } = SB;
  let n = 0;
  const uid = p => `${p}-mcp-${++n}`;

  const SCOPE = { local: 'just you, here', project: 'this project', user: 'yours', plugin: 'from a plugin' };

  /**
   * value: the step or routine ({ mcp?, mcpOnly? }), changed in place.
   * servers: [{ name, scope, direct }] or null while it's still being read.
   * onChange(): something changed. rebuild(i): redraw (the "only" box comes and
   * goes), keeping focus on box i; each box is data-fk `${fk}-${i}`.
   * slot(at, control): the editor's error slot, if it has one.
   */
  function field({ at, value, servers, onChange, rebuild, fk, slot }) {
    const picked = new Set(value.mcp || []);
    const list = [...(servers || [])];
    for (const name of picked) if (!list.some(s => s.name === name)) list.push({ name, scope: null, direct: false, missing: true });

    const set = (next, i) => {
      if (next.length) value.mcp = next; else { delete value.mcp; delete value.mcpOnly; }
      onChange();
      rebuild(i);
    };
    const boxes = list.map((s, i) => {
      const input = h('input', {
        type: 'checkbox', checked: picked.has(s.name), ...(fk ? { 'data-fk': `${fk}-${i}` } : {}),
        onchange: e => {
          if (e.target.checked) picked.add(s.name); else picked.delete(s.name);
          set(list.map(x => x.name).filter(x => picked.has(x)), i);
        },
      });
      const tag = s.missing ? 'not found' : SCOPE[s.scope] || '';
      return h('label', { class: 'wf-check mcp-pick' }, input,
        h('span', {}, h('span', { class: 'mcp-pick-name', text: s.name }), tag ? h('span', { class: 'field-hint', text: ` · ${tag}` }) : null));
    });

    const legendId = uid('legend');
    const empty = servers === null
      ? h('p', { class: 'field-hint', text: 'Looking for your MCP servers…' })
      : !list.length ? h('p', { class: 'field-hint', text: 'No MCP servers yet. Add one in Toolbox → MCP, and its tools can be used here.' }) : null;
    const err = slot ? slot(at, boxes[0]?.querySelector('input') || null) : null;

    let only = null;
    if (picked.size) {
      const plugin = [...picked].some(name => !list.find(s => s.name === name)?.direct);
      const box = h('input', { type: 'checkbox', checked: !!value.mcpOnly, onchange: e => { if (e.target.checked) value.mcpOnly = true; else delete value.mcpOnly; onChange(); } });
      only = h('label', { class: 'wf-check' }, box, h('span', {},
        h('span', { text: 'Only these servers' }),
        h('span', { class: 'field-hint', text: plugin
          ? 'Starts faster and keeps Claude to these tools. One you ticked can\'t be loaded on its own (it comes with a plugin, or Claude Code hasn\'t approved it yet), so leave this off.'
          : 'Starts faster and keeps Claude to these tools. Your other servers aren\'t loaded.' })));
    }

    return h('fieldset', { class: 'wf-fieldset mcp-field', 'aria-labelledby': legendId },
      h('legend', { class: 'field-label', id: legendId, text: 'MCP servers it can use without asking' }),
      empty,
      boxes.length ? h('div', { class: 'mcp-picks' }, boxes) : null,
      picked.size ? null : list.length ? h('p', { class: 'field-hint', text: 'None ticked: Claude still has your servers, but asks before using one. Tick the ones it needs so a run doesn\'t wait on you.' }) : null,
      only, err);
  }

  const BLANK = { string: '', number: 0, integer: 0, boolean: false, array: [], object: {} };

  /** A tool's input schema -> its arguments as JSON to fill in, required ones first. */
  function argsSkeleton(schema) {
    const props = schema && typeof schema.properties === 'object' && schema.properties ? schema.properties : {};
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const names = Object.keys(props).sort((a, b) => Number(required.includes(b)) - Number(required.includes(a))).slice(0, 20);
    if (!names.length) return '{}';
    const out = {};
    for (const k of names) {
      const t = Array.isArray(props[k]?.type) ? props[k].type[0] : props[k]?.type;
      out[k] = Object.hasOwn(BLANK, t) ? BLANK[t] : '';
    }
    return JSON.stringify(out, null, 2);
  }

  SB.mcpPicker = { field, argsSkeleton };
})();
