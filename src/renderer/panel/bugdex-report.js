/* Shellby panel — the fix report after a bug battle, and the rematch banner.
   The battle (src/main/bugdex/battle.js view) carries `report` (bugdex/quality.js:
   proof, firstTry, rootCause, wider) once it's caught, and `rematch` ({ n, last })
   when the bug was caught in this project before. bugdex-battle.js asks for the
   card under the jar and the banner over the screen; this only draws. Nothing
   here is ever put in as HTML. */
'use strict';
(function () {
  const { h } = SB;

  // Each quality, in the order the report lists them, with what it means.
  const ROWS = [
    { key: 'proof', icon: '🧪', label: 'Proof', yes: 'A new test proves the fix', no: 'No new test' },
    { key: 'rootCause', icon: '🌱', label: 'Root cause', yes: 'Fixed in the code, nothing silenced', no: 'Not fixed at the root' },
    { key: 'firstTry', icon: '🎯', label: 'First try', yes: 'Passed on the first re-run', no: 'Took a few runs' },
    { key: 'wider', icon: '🌊', label: 'Wider', yes: 'More tests passed than were failing', no: 'Only the failing tests ran' },
  ];
  const GRADES = ['Fixed', 'Good fix', 'Solid fix', 'Great fix', 'Perfect fix'];
  const LETTER = { p: '🧪', f: '🎯', r: '🌱', w: '🌊' };

  /** The report card, or null when there's no report (a remedy, a push, a settled merge). */
  function card(report) {
    const q = report && report.qualities;
    if (!q) return null;
    const score = ROWS.filter(r => q[r.key]).length;
    return h('div', { class: 'bb-report', role: 'group', 'aria-label': 'Fix report' },
      h('p', { class: 'bb-report-head' },
        h('b', { text: 'FIX REPORT' }),
        h('span', { class: `bb-report-grade g${score}`, text: GRADES[score] || GRADES[0] })),
      h('ul', { class: 'bb-report-rows' }, ROWS.map(r => h('li', { class: q[r.key] ? 'yes' : 'no', title: q[r.key] ? r.yes : r.no },
        h('span', { class: 'bb-report-icon', 'aria-hidden': 'true', text: r.icon }),
        h('span', { class: 'sr-only', text: `${r.label}: ${q[r.key] ? r.yes : r.no}` }),
        h('span', { 'aria-hidden': 'true', text: r.label })))),
      report.crew > 0 ? h('p', { class: 'bb-report-crew', text: `🦀 ${report.crew} helper${report.crew === 1 ? '' : 's'} pitched in` }) : null);
  }

  /** Report letters as icons ("🧪🌱"), or a dash for a fix with none. */
  const letters = q => (typeof q === 'string' && q ? [...q].map(c => LETTER[c] || '').join('') : '–');

  /** "It's back!": a ribbon over the screen for a rematch, with last time's report as a ghost card. */
  function banner(b) {
    const r = b && b.rematch;
    if (!r || !Number.isInteger(r.n)) return null;
    const last = r.last ? `Last time: ${letters(r.last.q)}${r.last.q && r.last.q.includes('p') ? '' : ' (no test)'}` : 'Seen here before';
    return h('div', { class: 'bb-rematch', role: 'note' },
      h('b', { text: `REMATCH #${r.n}` }),
      h('span', { class: 'bb-rematch-last', text: last }),
      h('span', { class: 'bb-rematch-tip', text: 'Win with a new test to seal it.' }));
  }

  SB.bugReport = { card, banner, letters };
})();
