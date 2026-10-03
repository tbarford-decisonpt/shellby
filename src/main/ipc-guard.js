// Who may call which channel. Every handler is registered through this, so a
// window can reach only what its own bridge offers: the crab's window (which
// draws friends' visiting crabs and stickers) can move him and take a drop,
// and nothing more, even if something it shows ever runs code. The panel gets
// its full bridge; no other window gets anything here (the confirmation
// windows answer on confirm.js's own channels, which check their sender).
//
// allow(channel, sender) -> boolean. A refused invoke rejects; a refused send
// is dropped. Either way it's written down once per channel.

function guardIpc(ipcMain, allow, { onRefused = () => {} } = {}) {
  const refusedOnce = new Set();
  const refuse = (channel, e) => {
    if (refusedOnce.has(channel)) return;
    refusedOnce.add(channel);
    onRefused(channel, e?.sender);
  };
  return {
    handle(channel, fn) {
      ipcMain.handle(channel, (e, ...args) => {
        if (!allow(channel, e.sender)) { refuse(channel, e); throw new Error('Not allowed from this window.'); }
        return fn(e, ...args);
      });
    },
    on(channel, fn) {
      ipcMain.on(channel, (e, ...args) => {
        if (!allow(channel, e.sender)) { refuse(channel, e); return; }
        return fn(e, ...args);
      });
    },
  };
}

// The crab's window: its own bridge (critter-preload.js), and nothing else.
const CRITTER_CHANNELS = /^(critter:(?!reset-position$)[a-z-]+|attach:image)$/;
// The pebble you throw for fetch (toy-preload.js): being dragged, and that's all.
const TOY_CHANNELS = /^toy:drag-(start|move|end)$/;

/** windows: () => ({ panel, critter, isToy(webContents) }), any of them possibly gone. */
function windowPolicy(windows) {
  return (channel, sender) => {
    const { panel, critter, isToy } = windows();
    if (sender && panel && sender === panel) return true;
    if (sender && critter && sender === critter) return CRITTER_CHANNELS.test(channel);
    if (sender && isToy?.(sender)) return TOY_CHANNELS.test(channel);
    return false;
  };
}

module.exports = { guardIpc, windowPolicy, CRITTER_CHANNELS, TOY_CHANNELS };
