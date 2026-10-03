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
    onCalm: on('critter:calm'),
    onVisitor: on('critter:visitor'),
    onTogether: on('critter:together'),
    onSticker: on('critter:sticker'),
    onStickerGlint: on('critter:sticker-glint'),
    pet: fire('critter:pet'),
    hit: fire('critter:hit'),
    onPerch: on('critter:perch'),
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
