/* Shellby panel — the Council's minutes (council.js): the verdict and its
   decision, what Shellby read before they sat, each advisor's answer, what to
   do with it, and how it went. Drawing only: council.js owns the session and
   hands in what each button does. */
'use strict';
(function () {
  const { h, state } = SB;
  const VOTE_MARK = { for: '✓', against: '✗', conditional: '~' };
  const VOTE_WORD = { for: 'For', against: 'Against', conditional: 'Depends' };
  const DECISION_WORD = { do: 'Do it', dont: 'Don’t', first: 'First, this' };
  const OUTCOMES = [
    { result: 'worked', label: 'Followed it, and it worked' },
    { result: 'failed', label: 'Followed it, and it didn’t' },
    { result: 'skipped', label: 'Didn’t follow it' },
  ];
  const OUTCOME_SAID = { worked: 'You followed it, and it worked.', failed: 'You followed it, and it didn’t work.', skipped: 'You didn’t follow it.' };

  function crab(seat) {
    if (seat.id === 'chair') return SB.sprite(state.skin);
    const svg = SB.Sprite.build(state.skin, { accessories: state.outfit?.crewAccessories ?? [], fit: true });
    svg.style.filter = `hue-rotate(${SB.HUES[seat.hue % SB.HUES.length]}deg) saturate(1.1)`;
    return svg;
  }

  function meter(n, label) {
    return h('span', { class: 'cc-meter', role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(n), title: `${label}: ${n}%` },
      h('i', { style: `--v:${n}%` }), h('b', { text: `${n}%` }));
  }

  // A fact's file, as a link that opens it at the line.
  const source = (s, f) => {
    const label = `${f.file}${f.line ? `:${f.line}` : ''}`;
    if (!s.root) return h('code', { text: label });
    const abs = `${s.root.replace(/[\\/]+$/, '')}\\${f.file.replace(/\//g, '\\')}`;
    return SB.fileLink(abs, { line: f.line || null, text: label, cls: 'cc-src' });
  };

  // [F2] chips: a press finds the fact in What he read and lights it on the table.
  const citeChips = (cites, onCite) => (cites?.length
    ? h('span', { class: 'cc-cites' }, cites.map(n => h('button', { type: 'button', class: 'cc-cite', title: `Fact ${n}`, onclick: () => onCite(n) }, `F${n}`)))
    : null);

  function facts(s, onCite) {
    const list = s.facts || [];
    const notes = [
      s.readError ? `He didn’t read ${s.project || 'the project'} this time. ${s.readError}` : '',
      s.dropped ? `${s.dropped} more ${s.dropped === 1 ? 'fact' : 'facts'} named a file that isn’t there, so ${s.dropped === 1 ? 'it was' : 'they were'} left out.` : '',
      s.hidden ? `${s.hidden} ${s.hidden === 1 ? 'fact came' : 'facts came'} from a file that holds secrets, so ${s.hidden === 1 ? 'it was' : 'they were'} left out.` : '',
    ].filter(Boolean);
    if (!list.length && !notes.length && !s.unknowns?.length) return null;
    return h('section', { class: 'cc-read', 'aria-label': 'What he read' },
      h('h4', { text: list.length ? `What he read in ${s.project || 'the project'}` : 'What he read' }),
      list.length ? h('ol', { class: 'cc-facts' }, list.map((f, i) => h('li', { dataset: { fact: String(i + 1) } },
        h('button', { type: 'button', class: 'cc-fact-n', 'aria-label': `Light up fact ${i + 1} on the table`, onclick: () => onCite(i + 1) }, `F${i + 1}`),
        h('span', { text: f.claim }), source(s, f)))) : null,
      s.unknowns?.length ? h('p', { class: 'muted small cc-unknowns' }, h('b', { text: 'Not in the project: ' }), s.unknowns.join(' · ')) : null,
      ...notes.map(t => h('p', { class: 'muted small', text: t })));
  }

  function outcome(s, onOutcome) {
    const said = s.outcome?.result;
    return h('div', { class: 'cc-outcome', role: 'group', 'aria-label': 'How did it go?' },
      h('span', { class: 'cc-outcome-q', text: said ? OUTCOME_SAID[said] : 'How did it go?' }),
      ...OUTCOMES.map(o => h('button', {
        type: 'button', class: `btn ghost slim-btn${said === o.result ? ' is-on' : ''}`, 'aria-pressed': String(said === o.result),
        onclick: () => onOutcome(said === o.result ? null : o.result),
      }, o.label)),
      h('span', { class: 'muted small', text: 'Each advisor’s record comes from this, and the chair weighs it.' }));
  }

  /** The verdict card. act: { plan, note, answerOpen, copy, followUp, outcome, cite }. */
  function verdict(s, act) {
    const c = s.chair;
    const list = (title, items, cls = '') => (items?.length ? h('div', { class: `cc-list ${cls}` }, h('h4', { text: title }), h('ul', {}, items.map(t => h('li', { text: t })))) : null);
    return [
      h('header', {},
        h('p', { class: 'cc-eyebrow', text: s.question }),
        c?.decision ? h('span', { class: 'cc-seal', dataset: { decision: c.decision } }, DECISION_WORD[c.decision]) : null,
        h('h3', { text: c ? c.verdict : 'No verdict this time' }),
        c ? h('div', { class: 'cc-verdict-meta' }, meter(c.confidence, 'Chair’s confidence'), citeChips(c.cites, act.cite)) : null),
      c?.against ? h('p', { class: 'cc-against' }, h('b', { text: 'The best case against: ' }), c.against) : null,
      ...(c ? [h('div', { class: 'cc-lists' }, list('They agree', c.agree), list('They split', c.split), list('Next steps', c.next), list('Still open', c.open, 'is-open'))] : []),
      facts(s, act.cite),
      h('div', { class: 'cc-actions' },
        c ? h('button', { type: 'button', class: 'btn primary', onclick: act.plan, title: 'A new conversation in Plan mode, with the verdict and its facts ready to send' }, 'Plan the next steps') : null,
        c?.open?.length && s.root ? h('button', { type: 'button', class: 'btn', onclick: act.answerOpen, title: 'He reads the project for what’s still open, and the council sits again' }, 'Answer what’s open') : null,
        c ? h('button', { type: 'button', class: 'btn', onclick: act.note }, 'Add to Notes') : null,
        h('button', { type: 'button', class: 'btn ghost', onclick: act.copy }, 'Copy minutes'),
        c ? h('button', { type: 'button', class: 'btn ghost cc-follow', onclick: act.followUp }, 'Ask a follow-up') : null,
        h('span', { class: 'muted small cc-cost', text: costLine(s) })),
      c ? outcome(s, act.outcome) : null,
    ];
  }

  function opinionRow(s, seat, onCite) {
    const o = s.opinions?.[seat.id], r = s.rebuttals?.[seat.id];
    const icon = h('span', { class: 'cc-row-crab', 'aria-hidden': 'true' }, state.skin ? crab(seat) : null);
    if (!o) return h('li', { class: 'cc-row is-silent', dataset: { seat: seat.id } }, icon, h('div', {}, h('h4', { text: seat.name }), h('p', { class: 'muted small', text: 'Didn’t answer this time.' })));
    const v = r?.vote || o.vote;
    const to = r?.to ? s.seats.find(x => x.id === r.to)?.name : '';
    return h('li', { class: 'cc-row', dataset: { seat: seat.id } }, icon,
      h('div', { class: 'cc-row-body' },
        h('div', { class: 'cc-row-head' },
          h('h4', { text: seat.name }),
          h('span', { class: 'cc-chip', dataset: { vote: v } }, `${VOTE_MARK[v]} ${VOTE_WORD[v]}`),
          r?.changed ? h('span', { class: 'cc-changed', title: `Was ${VOTE_WORD[o.vote].toLowerCase()} before hearing the others` }, 'Changed their mind') : null,
          meter(o.confidence, `${seat.name}’s confidence`)),
        h('p', { class: 'cc-stance', text: o.stance }),
        o.argument ? h('p', { class: 'cc-argument', text: o.argument }) : null,
        o.condition ? h('p', { class: 'cc-cond' }, h('b', { text: 'Depends on: ' }), o.condition) : null,
        o.risks.length ? h('ul', { class: 'cc-risks', 'aria-label': 'Risks' }, o.risks.map(t => h('li', { text: t }))) : null,
        o.wouldChange ? h('p', { class: 'cc-flip' }, h('b', { text: 'Would change their mind: ' }), o.wouldChange) : null,
        citeChips(o.cites, onCite),
        r ? h('p', { class: 'cc-rebuttal' }, h('b', { text: to ? `To the ${to}: ` : 'After hearing the others: ' }), r.reply) : null));
  }

  // Dollars as the cost hint reads them: "$0.42", "under $0.01".
  const usd = n => (n < 0.01 ? 'under $0.01' : `$${n.toFixed(2)}`);

  /** What a sitting cost, from what each call reported: "at least" when some didn't say. */
  const spentText = s => {
    const cost = Number.isFinite(s.cost) ? s.cost : 0;
    if (!cost) return s.unpriced ? 'cost not reported' : '';
    return `${s.unpriced ? 'at least ' : ''}${usd(cost)}`;
  };

  /** What the next sitting should cost: "About $0.07–0.39". */
  const estimateText = e => {
    if (!e || !Number.isFinite(e.low) || !Number.isFinite(e.high)) return '';
    const low = usd(e.low), high = usd(e.high);
    if (e.low < 0.01) return e.high < 0.01 ? 'Under $0.01' : `Under ${high}`;
    return low === high ? `About ${low}` : `About ${low}–${high.replace(/^\$/, '')}`;
  };

  const costLine = s => {
    const calls = `${s.calls} call${s.calls === 1 ? '' : 's'}`;
    const spent = spentText(s);
    return spent ? `${calls} · ${spent} of your plan` : calls;
  };

  function text(s) {
    const lines = [`Council: ${s.question}`, ''];
    const c = s.chair;
    if (c) {
      lines.push(`Verdict (${c.confidence}%): ${c.decision ? `${DECISION_WORD[c.decision]}. ` : ''}${c.verdict}`);
      if (c.against) lines.push(`Best case against: ${c.against}`);
      for (const [t, items] of [['Agree', c.agree], ['Split', c.split], ['Next', c.next], ['Still open', c.open || []]]) if (items.length) lines.push(`${t}:`, ...items.map(x => `- ${x}`));
      lines.push('');
    }
    if (s.facts?.length) lines.push('What he read:', ...s.facts.map((f, i) => `[F${i + 1}] ${f.claim} (${f.file}${f.line ? `:${f.line}` : ''})`), '');
    for (const seat of s.seats) {
      const o = s.opinions[seat.id];
      if (!o) continue;
      lines.push(`${seat.name} [${o.vote}${o.condition ? ` if ${o.condition}` : ''}, ${o.confidence}%]: ${o.stance}`, `  ${o.argument}`);
      if (o.wouldChange) lines.push(`  Would change their mind: ${o.wouldChange}`);
      const r = s.rebuttals?.[seat.id];
      if (r) lines.push(`  After hearing the others [${r.vote}]: ${r.reply}`);
    }
    return lines.join('\n');
  }

  SB.councilMinutes = { crab, meter, verdict, opinionRow, text, spentText, estimateText, VOTE_MARK, VOTE_WORD, DECISION_WORD };
})();
