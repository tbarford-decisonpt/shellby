/* Shellby panel — rooms: someone new starts with the crab and the chat box, and
   the other screens join the bar as he finishes tasks (main/rooms.js decides
   which). A room that opens gets a card and a glow on its button; "More" says
   what opens next and can open everything at once. Going to a screen by any
   other road (Ctrl+K, a link) opens it for good. Just-the-crab mode has its own
   bar (crabonly.css) and ignores rooms, and so does Work mode (workmode.js),
   which shows every tool from the start. */
'use strict';
(function () {
  const { api, state, $ } = SB;
  const GLOW_MS = 3400;

  let view = null; // main's roomsView(); null until it arrives (everything shows)

  const lockedIds = () => {
    if (!view || view.all || SB.isCrabOnly() || SB.isWorkMode?.()) return [];
    const open = new Set(view.open);
    return [...document.querySelectorAll('.dock [data-view-btn]')]
      .map(b => b.dataset.viewBtn)
      .filter(id => id !== 'wardrobe' && id !== 'chat' && !open.has(id));
  };
  SB.isRoomLocked = id => lockedIds().includes(id);

  function apply() {
    const locked = new Set(lockedIds());
    for (const b of document.querySelectorAll('.dock [data-view-btn]')) b.classList.toggle('room-locked', locked.has(b.dataset.viewBtn));
    const more = $('dockMore');
    more.hidden = !locked.size;
    if (!locked.size) return;
    more.title = moreText();
    more.setAttribute('aria-label', `More screens: ${moreText()}`);
  }

  function moreText() {
    const n = view?.next;
    if (!n) return 'More screens open as he works.';
    return `${n.name} opens after ${n.tasksToGo === 1 ? (view.tasks ? 'his next task' : 'his first task') : `${n.tasksToGo} more tasks`}.`;
  }

  function glow(id) {
    const b = document.querySelector(`.dock [data-view-btn="${id}"]`);
    if (!b) return;
    b.classList.remove('room-new');
    void b.offsetWidth;
    b.classList.add('room-new');
    setTimeout(() => b.classList.remove('room-new'), GLOW_MS);
  }

  function received({ view: v, opened = [] } = {}) {
    if (!v) return;
    view = v;
    document.body.classList.add('rooms-ready');
    apply();
    if (SB.isCrabOnly() || SB.isWorkMode?.() || !opened.length) return;
    opened.forEach(r => glow(r.id));
    const [first] = opened;
    SB.celebrate({
      eyebrow: 'New room',
      icon: '🚪',
      title: opened.length > 1 ? `${opened.slice(0, -1).map(r => r.name).join(', ')} and ${opened.at(-1).name} are open` : `${first.name} is open`,
      text: opened.map(r => r.text).join(' '),
      action: { label: 'Take a look', run: () => SB.setView(first.id) },
    });
  }

  SB.openAllRooms = async () => {
    received({ view: await api.openAllRooms() });
    SB.toast('Every screen is on the bar now.');
  };
  SB.hasLockedRooms = () => lockedIds().length > 0;

  $('dockMore').addEventListener('click', () => SB.toast(moreText(), { action: 'Show every screen', onAction: SB.openAllRooms, ms: 5000 }));

  // Got there another way (Ctrl+K, a link, a notification): that room stays open.
  const setView = SB.setView;
  SB.setView = target => {
    setView(target);
    const section = SB.NAV_SECTION[state.view] || state.view;
    if (SB.isRoomLocked(section)) api.openRoom(section).then(v => received({ view: v })).catch(() => {}); // the screen showed; only the door stays shut
  };

  // Switching in or out of just the crab changes which bar shows. Leaving it from
  // Health (its home) for a bar where Health isn't open yet goes to the chat.
  const applyCrabOnly = SB.applyCrabOnly;
  SB.applyCrabOnly = () => {
    applyCrabOnly();
    apply();
    if (SB.isRoomLocked(SB.NAV_SECTION[state.view] || state.view)) setView('chat');
  };

  api.onRooms(received);
  // Never leave the bar hidden: if main can't answer, every screen shows.
  api.getRooms().then(v => received({ view: v })).catch(() => document.body.classList.add('rooms-ready'));
})();
