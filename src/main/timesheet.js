// A printable timesheet for a client: each project's days, hours and what was
// done, with the rate and the amount when there is one. timetrack-service.js
// renders it to a PDF in a hidden window with scripts off.
//
// Everything in it (project names, notes, commit messages) is escaped: commit
// messages are written by anyone who can push, and this is HTML. Pure; see
// test/timetrack.test.js.
const { hours, money, lineText } = require('./timetrack');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const longDate = day => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

function projectTable(p, currency) {
  const rows = p.days.filter(r => r.total).map(r => `
      <tr>
        <td class="date">${esc(longDate(r.day))}</td>
        <td>${esc(lineText(r)) || '<span class="muted">Work on the project</span>'}${r.estimated ? ' <span class="tag">from commits</span>' : ''}</td>
        <td class="num">${hours(r.billed).toFixed(2)}</td>
      </tr>`).join('');
  const pay = p.billable && p.rate
    ? `<tr class="sub"><td></td><td>${hours(p.billed).toFixed(2)} h × ${esc(money(p.rate, currency))}/h</td><td class="num">${esc(money(p.amount, currency))}</td></tr>`
    : p.billable ? '' : '<tr class="sub"><td></td><td colspan="2" class="muted">Not billable</td></tr>';
  return `
  <section>
    <h2>${esc(p.name)}${p.client ? ` <span class="client">${esc(p.client)}</span>` : ''}</h2>
    <table>
      <thead><tr><th class="date">Date</th><th>Work</th><th class="num">Hours</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="sub"><td></td><td>Total</td><td class="num">${hours(p.billed).toFixed(2)}</td></tr>
        ${pay}
      </tfoot>
    </table>
  </section>`;
}

/**
 * summary: timetrack.summarize(); opts: { title, label, preparedBy, generatedAt }
 */
function timesheetHtml(summary, { title = 'Timesheet', label = '', preparedBy = '', generatedAt = Date.now() } = {}) {
  const shown = summary.projects.filter(p => p.days.some(r => r.total));
  const clients = [...new Set(shown.map(p => p.client).filter(Boolean))];
  const period = `${longDate(summary.from)} – ${longDate(summary.to)}`;
  const notes = [
    summary.roundMinutes ? `Each day is rounded ${summary.roundMode === 'up' ? 'up ' : ''}to ${summary.roundMinutes} minutes.` : '',
    shown.some(p => p.days.some(r => r.estimated)) ? 'Days marked “from commits” are estimated from the git history.' : '',
  ].filter(Boolean).join(' ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.45 "Segoe UI", system-ui, sans-serif; color: #1d2733; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1d2733; padding-bottom: 10px; margin-bottom: 18px; }
  h1 { font-size: 20pt; margin: 0; letter-spacing: -0.01em; }
  .meta { text-align: right; color: #4a5a6a; font-size: 9.5pt; }
  .meta b { color: #1d2733; }
  h2 { font-size: 12pt; margin: 18px 0 6px; }
  .client { font-weight: 400; color: #4a5a6a; font-size: 10pt; margin-left: 6px; }
  table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em; color: #4a5a6a; border-bottom: 1px solid #c9d2db; padding: 4px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #edf1f4; vertical-align: top; }
  .date { width: 26%; white-space: nowrap; }
  .num { text-align: right; width: 16%; white-space: nowrap; font-variant-numeric: tabular-nums; }
  tfoot td { border-bottom: none; font-weight: 600; }
  .muted { color: #7a8794; }
  .tag { font-size: 8pt; color: #4a5a6a; border: 1px solid #c9d2db; border-radius: 3px; padding: 0 4px; white-space: nowrap; }
  .total { margin-top: 22px; border-top: 2px solid #1d2733; padding-top: 10px; display: flex; justify-content: space-between; font-size: 12pt; font-weight: 700; }
  footer { margin-top: 18px; color: #7a8794; font-size: 8.5pt; }
</style></head>
<body>
  <header>
    <div>
      <h1>${esc(title)}</h1>
      ${clients.length === 1 ? `<div>${esc(clients[0])}</div>` : ''}
    </div>
    <div class="meta">
      <div><b>${esc(period)}</b>${label ? ` · ${esc(label)}` : ''}</div>
      ${preparedBy ? `<div>Prepared by ${esc(preparedBy)}</div>` : ''}
      <div>Generated ${esc(new Date(generatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))}</div>
    </div>
  </header>
  ${shown.length ? shown.map(p => projectTable(p, summary.currency)).join('') : '<p class="muted">No time in this period.</p>'}
  <div class="total">
    <span>Total ${hours(summary.totals.billed).toFixed(2)} billable hours</span>
    <span>${summary.totals.amount ? esc(money(summary.totals.amount, summary.currency)) : ''}</span>
  </div>
  ${notes ? `<footer>${esc(notes)}</footer>` : ''}
</body></html>`;
}

/** A file name for an export: "Acme - shellby - 2026-09-29 to 2026-10-03". */
function exportName(summary, { client = '', project = '' } = {}) {
  const parts = [client, project, summary.from === summary.to ? summary.from : `${summary.from} to ${summary.to}`].filter(Boolean);
  return `Timesheet - ${parts.join(' - ')}`.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

module.exports = { timesheetHtml, exportName, esc };
