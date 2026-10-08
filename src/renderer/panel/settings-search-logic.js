// Searching Settings (settings-search.js draws it): which sections and which
// rows inside them a search keeps. Every word has to be there, in any order;
// a section whose name or heading matches keeps all of its rows. Pure, no
// DOM. Works in the browser and in Node (for tests).
(function (root) {
  const fold = s => String(s || '').toLowerCase().replace(/[‘’`]/g, "'").replace(/\s+/g, ' ');

  /** The words of a search, lowercased, each once. */
  function terms(query) {
    return [...new Set(fold(query).split(' ').filter(Boolean))];
  }

  const has = (text, words) => {
    const t = fold(text);
    return words.every(w => t.includes(w));
  };

  // section: { head, units } where head is the section's name and heading, and
  // units the text of each row in it. -> { show, units: [bool] } (all true
  // when the head matches, or when there's no search).
  function plan(section, words) {
    const units = section.units || [];
    if (!words.length || has(section.head, words)) return { show: true, units: units.map(() => true) };
    const kept = units.map(u => has(`${section.head} ${u}`, words));
    return { show: kept.some(Boolean), units: kept };
  }

  // The line under the box: what was found, or that nothing was.
  function summary(found, query) {
    const q = String(query || '').trim();
    if (!q) return '';
    if (!found) return `Nothing in Settings matches “${q}”. Try another word, or Ctrl+K to search everything.`;
    return found === 1 ? `1 section matches “${q}”.` : `${found} sections match “${q}”.`;
  }

  const api = { terms, plan, summary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbySettingsSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
