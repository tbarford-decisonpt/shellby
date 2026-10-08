// Room in the crab's window for his helper crabs and a visiting friend's: the
// window grows to the left to fit them, keeping Shellby himself anchored in
// place, and shrinks once they've walked home. And saving his spot, which is
// his own, not the widened window's left edge.
// Kept out of main.js, which only wires it up.
const { clampToDisplays } = require('../placement');

const SHRINK_AFTER_MS = 1100; // let helpers walk home first

/** d: what main shares (main.js `shared`). */
function wireCrewSlots(d) {
  let shrinkTimer = null;

  function setCrewSlots(n, guest = !!d.visitor) {
    n = Math.min(n, d.MAX_CREW_SHOWN);
    // A shrink still pending from a moment ago would cut off whoever just arrived.
    clearTimeout(shrinkTimer);
    if (n === d.crewShown && guest === d.guestShown) return;
    const growing = n > d.crewShown || (guest && !d.guestShown);
    // Helpers and a visiting crab line up on the floor beside him, so he comes
    // down off any window first. The refresh after he lands brings them out.
    if (growing && d.perching?.isAway()) { d.perching.leave('crew'); return; }
    // ...and lets go of a wall or the ceiling: his window can't widen while he's turned.
    if (growing && d.climbing?.isAway()) { d.climbing.leave(); return; }
    const apply = (slots, g) => {
      const b = d.critter.getBounds();
      const base = d.critterBaseSize();
      const width = base.width + d.crewExtra(slots, g);
      d.crewShown = slots;
      d.guestShown = g;
      d.critter.setBounds({ x: b.x + b.width - width, y: b.y, width, height: base.height });
    };
    d.motion?.stop(); // a throw or stroll would put back the old left edge
    if (n > d.crewShown || (guest && !d.guestShown)) apply(Math.max(n, d.crewShown), guest || d.guestShown);
    // Grown for the newcomer; anyone leaving still gets the shrink below.
    if (n === d.crewShown && guest === d.guestShown) return;
    shrinkTimer = setTimeout(() => apply(n, guest), SHRINK_AFTER_MS);
  }

  function saveCritterPos() {
    const b = d.critter.getBounds();
    const c = clampToDisplays(b, d.workAreas());
    if (c.x !== b.x || c.y !== b.y) d.placeCritter(c.x, c.y);
    // Persist Shellby's own spot, not the crew-widened window's left edge.
    d.config.set({ critterPos: { x: c.x + d.crewExtra(), y: c.y } });
  }

  return { setCrewSlots, saveCritterPos };
}

module.exports = { wireCrewSlots };
