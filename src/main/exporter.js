// /export: a conversation as a Markdown file (or on the clipboard), from the
// transcript Shellby keeps. What you said, what Claude said, each tool it
// used in one line, and the marks along the way (changes, compactions,
// rewinds). Pure; see test/exporter.test.js.

const fence = text => {
  const t = String(text ?? '');
  const ticks = Math.max(3, ...[...t.matchAll(/`{3,}/g)].map(m => m[0].length + 1));
  return '`'.repeat(ticks) + '\n' + t + '\n' + '`'.repeat(ticks);
};

const quote = text => String(text ?? '').split('\n').map(l => `> ${l}`).join('\n');
const when = t => (Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '');

function toMarkdown(entry, items) {
  const out = [];
  const title = entry?.title || 'Conversation';
  out.push(`# ${title}`, '');
  const meta = [entry?.cwd ? `Folder: \`${entry.cwd}\`` : null, entry?.createdAt ? `Started: ${when(entry.createdAt)}` : null, 'Exported from Shellby'].filter(Boolean);
  out.push(meta.join(' · '), '');
  for (const i of Array.isArray(items) ? items : []) {
    if (!i || i.sub) continue;
    switch (i.kind) {
      case 'user':
        out.push('---', '', `**You**${i.t ? ` · ${when(i.t)}` : ''}`, '', quote(i.text || ''), '');
        if (i.attachments?.length) out.push(...i.attachments.map(a => `- 📎 \`${a}\``), '');
        break;
      case 'text':
        out.push('**Claude**', '', i.text, '');
        break;
      case 'tool':
        out.push(`- *${i.label}* ${i.detail ? `\`${String(i.detail).replace(/`/g, "'")}\`` : ''}`.trimEnd());
        if (i.plan) out.push('', fence(i.plan), '');
        break;
      case 'shell':
        out.push('**You ran**', '', fence(`> ${i.command}\n${i.output || ''}`), '');
        break;
      case 'changes':
        out.push('', `*Changed ${i.files?.length || 0} file${i.files?.length === 1 ? '' : 's'}:* ${(i.files || []).slice(0, 30).map(f => `\`${f.path}\``).join(', ')}`, '');
        break;
      case 'result':
        if (!i.ok && !i.interrupted && i.error) out.push('', `> ⚠ ${String(i.error).split('\n')[0]}`, '');
        if (i.interrupted) out.push('', '*(stopped)*', '');
        break;
      case 'compacted': out.push('', '*— conversation compacted —*', ''); break;
      case 'fresh': out.push('', '*— started fresh from the summary above —*', ''); break;
      case 'rewound': out.push('', `*— rewound to an earlier message —*`, ''); break;
      case 'error': out.push('', `> ⚠ ${String(i.text || '').split('\n')[0]}`, ''); break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** A file name for it: the title, minus what Windows won't take. */
function fileName(entry) {
  const base = String(entry?.title || 'conversation').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'conversation';
  return `${base}.md`;
}

module.exports = { toMarkdown, fileName };
