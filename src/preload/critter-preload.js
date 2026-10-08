// The crab's own bridge, deliberately small. His window draws things other
// people chose (a friend's visiting crab, stickers), so it gets moving him,
// clicks and a file drop, and none of the panel's tasks, settings or shell.
// Main checks the same list from its side (src/main/ipc-guard.js).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = channel => cb => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const fire = channel => (...args) => ipcRenderer.send(channel, ...args);

contextBridge.exposeInMainWorld('shellby', {
  critter: {
    dragStart: fire('critter:drag-start'),
    dragMove: (dx, dy) => ipcRenderer.send('critter:drag-move', { dx, dy }),
    dragEnd: fire('critter:drag-end'),
    click: fire('critter:click'),
    crewClick: fire('critter:crew-click'),
    bgClick: fire('critter:bg-click'),
    serversClick: fire('critter:servers-click'), // the dev server pill or sign
    menu: fire('critter:menu'),
    drop: fire('critter:drop'),
    onState: on('critter:state'),
    onSkin: on('critter:skin'),
    onBurst: on('critter:burst'),
    onXp: on('critter:xp'),
    onMolt: on('critter:molt'),
    onMotion: on('critter:motion'),
    onBit: on('critter:bit'),
    onChirp: on('critter:chirp'),
    onSurprise: on('critter:surprise'), // a crit hit or a clean landing (src/main/surprises.js)
    onSound: on('critter:sound'), // a ta-da and the like (src/renderer/critter/sound.js)
    onCalm: on('critter:calm'),
    onVisitor: on('critter:visitor'),
    onBuddy: on('critter:buddy'), // his favourite Bugdex catch, following him (src/main/wiring/bugdex.js)
    onTogether: on('critter:together'),
    onSticker: on('critter:sticker'),
    onStickerGlint: on('critter:sticker-glint'),
    pet: fire('critter:pet'),
    hit: fire('critter:hit'),
    // Windows' animation effects off (prefers-reduced-motion): main holds his window still too.
    reducedMotion: on => ipcRenderer.send('critter:reduced-motion', on === true),
    onPerch: on('critter:perch'),
    onSurface: on('critter:surface'), // which way up he is: on the floor, a wall or the ceiling (src/main/climbing.js)
    // His life between tasks (src/main/life.js, playtime.js): where your cursor
    // is, a prop for a scene, something in his claw or on his face, and what a
    // visiting crab says back.
    onLook: on('critter:look'),
    onProp: on('critter:prop'),
    onHold: on('critter:hold'),
    onWear: on('critter:wear'),
    onVisitorSay: on('critter:visitor-say'),
    // You came back after a while away: he says hello (src/main/main.js greet).
    onGreet: on('critter:greet'),
    // You're typing (src/main/typing.js): tap along, faster, or look on impressed.
    onTyping: on('critter:typing'),
  },

  // Files dropped on him: their paths, or (for a picture with no file behind
  // it) a copy main saves first. Same as the panel's attachFiles.
  attachFiles: async files => {
    const paths = [];
    let error = null;
    for (const f of Array.from(files || []).slice(0, 20)) {
      let p = '';
      try { p = webUtils.getPathForFile(f); } catch { /* not on disk */ }
      if (p) { paths.push(p); continue; }
      if (!/^image\//.test(f.type)) continue;
      const r = await ipcRenderer.invoke('attach:image', new Uint8Array(await f.arrayBuffer()));
      if (r?.path) paths.push(r.path); else error = r?.error || 'Couldn’t attach that picture.';
    }
    return { paths, error };
  },
});
