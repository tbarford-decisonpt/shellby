/* Shellby panel — what clash warnings say (pure, no DOM), for clashes.js.
   A clash is from main (src/main/clash.js): { key, root, base, files, more,
   copies: [{ tabId, title, branch, checkout? }] }. titleOf(tabId) gives the
   name a tab has now, since tabs get renamed after main last looked. */
'use strict';
(function (root) {
  // shellby/fix-login-1a2b3c -> fix-login: the part you'd recognise.
  const shortBranch = b => String(b || '').replace(/^shellby\//, '').replace(/-[0-9a-f]{6}$/, '');

  const nameOf = (m, titleOf) => (m.checkout ? 'your checkout' : `‘${(titleOf && titleOf(m.tabId)) || m.title || shortBranch(m.branch)}’`);

  // "a.js", "a.js and b.js", "a.js, b.js and 3 more"
  function fileList(files, more = 0, shown = 3) {
    const list = (files || []).slice(0, shown);
    const rest = (files || []).length - list.length + (more || 0);
    if (!list.length) return 'the same files';
    if (rest > 0) return `${list.join(', ')} and ${rest} more`;
    if (list.length === 1) return list[0];
    return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  }

  const joinNames = names => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

  /** The clashes a tab is in, each with the others in it. */
  function forTab(clashes, tabId) {
    if (!tabId) return [];
    return (clashes || []).filter(c => (c.copies || []).some(m => !m.checkout && m.tabId === tabId))
      .map(c => ({ clash: c, others: c.copies.filter(m => m.checkout || m.tabId !== tabId) }));
  }

  /** The same, turned round: each other copy once, with every file it shares
      with this tab. Several clashes with one tab read as one, not a pile. */
  function byCopy(clashes, tabId) {
    const seen = new Map();
    for (const { clash, others } of forTab(clashes, tabId)) {
      for (const copy of others) {
        const key = copy.checkout ? 'checkout' : copy.tabId;
        const got = seen.get(key) || { copy, files: [], more: 0 };
        seen.set(key, {
          ...got,
          files: [...new Set([...got.files, ...(clash.files || [])])],
          more: Math.max(got.more, clash.more || 0), // the unlisted ones may be the same files
        });
      }
    }
    return [...seen.values()];
  }

  // "⑂ new-nav" for a copy, "your checkout" for yours.
  const otherLabel = m => (m.checkout ? 'your checkout' : `⑂ ${shortBranch(m.branch) || m.title}`);

  /** One line for a tab: "Also changed in ⑂ new-nav: src/main/merge.js". */
  function line(clashes, tabId) {
    const mine = byCopy(clashes, tabId);
    if (!mine.length) return '';
    return 'Also changed in ' + mine.map(({ copy, files, more }) => `${otherLabel(copy)}: ${fileList(files, more, 2)}`).join('; ');
  }

  // A toast is a glance, not a read: long tab titles are cut to a recognisable start.
  const TOAST_NAME = 24;
  function clip(name) { // name is quoted: ‘…’
    if (name.length <= TOAST_NAME + 2) return name;
    const cut = name.slice(0, TOAST_NAME + 2);
    const space = cut.lastIndexOf(' ');
    return `${(space > TOAST_NAME / 2 ? cut.slice(0, space) : cut).replace(/[\s.,:;?!-]+$/, '')}…’`;
  }

  /** The toast when a clash first appears: { title, text }. The title says
      which files; the text says who changed them and what that means. */
  function toast(clash, titleOf) {
    const title = `Clash in ${fileList(clash.files, clash.more, 2)}`;
    const it = (clash.files || []).length + (clash.more || 0) > 1 ? 'them' : 'it';
    const tabs = clash.copies.filter(m => !m.checkout);
    const yours = clash.copies.some(m => m.checkout);
    const names = tabs.map(m => clip(nameOf(m, titleOf)));
    if (yours) {
      return {
        title,
        text: tabs.length === 1
          ? `Tab ${names[0]} and your checkout (not committed) both changed ${it}. Bringing it home will clash.`
          : `Tabs ${joinNames(names)} and your checkout all changed ${it}. Bringing them home will clash.`,
      };
    }
    return {
      title,
      text: tabs.length === 2
        ? `Tabs ${names[0]} and ${names[1]} both changed ${it}. Bringing both home will clash.`
        : `Tabs ${joinNames(names)} all changed ${it}. Bringing them all home will clash.`,
    };
  }

  /** What "Ask him to look" puts in the tab's box, unsent. */
  function prompt(clashes, tabId) {
    const mine = forTab(clashes, tabId);
    if (!mine.length) return '';
    const base = mine[0].clash.base;
    const branches = [...new Set(mine.flatMap(x => x.others.filter(m => !m.checkout).map(m => m.branch)).filter(Boolean))];
    const theirFiles = [...new Set(mine.filter(x => x.others.some(m => !m.checkout)).flatMap(x => x.clash.files))];
    const yourFiles = [...new Set(mine.filter(x => x.others.some(m => m.checkout)).flatMap(x => x.clash.files))];
    const more = mine.reduce((n, x) => n + (x.clash.more || 0), 0);
    const bits = [];
    if (branches.length) {
      const which = branches.length === 1 ? `Another copy (branch ${branches[0]}) also changed` : `Other copies (branches ${joinNames(branches)}) also changed`;
      bits.push(`${which} ${fileList(theirFiles, 0, 8)}. You can see its changes with git diff ${base}...${branches[0]}.`);
    }
    if (yourFiles.length) bits.push(`My own checkout has uncommitted changes to ${fileList(yourFiles, 0, 8)}, which this copy changed too.`);
    if (more) bits.push(`(${more} more files overlap as well.)`);
    bits.push(`Check whether our changes overlap and how to avoid a merge clash when this is brought home into ${base}. Don't change the other copy or my checkout; tell me what you'd do first.`);
    return bits.join(' ');
  }

  const api = { shortBranch, fileList, forTab, byCopy, line, toast, prompt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyClashText = api;
})(typeof window !== 'undefined' ? window : globalThis);
