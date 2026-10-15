// Pure geometry helpers for positioning the critter and panel (unit-tested).

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Keep a window rect fully visible. If it no longer overlaps any display
// (e.g. its monitor was unplugged), move it to the primary display's corner.
function clampToDisplays(rect, workAreas, margin = 24) {
  const home = workAreas.find(wa => intersects(rect, wa));
  const wa = home || workAreas[0];
  if (!home) {
    return { ...rect, x: wa.x + wa.width - rect.width - margin, y: wa.y + wa.height - rect.height - margin };
  }
  return {
    ...rect,
    x: Math.min(Math.max(rect.x, wa.x), wa.x + wa.width - rect.width),
    y: Math.min(Math.max(rect.y, wa.y), wa.y + wa.height - rect.height),
  };
}

// Put the panel beside the critter: prefer the left side, flip right if there's
// no room, bottom-aligned with the critter, clamped to the work area.
function panelPosition(critter, panelSize, workArea, gap = 12) {
  let x = critter.x - panelSize.width - gap;
  if (x < workArea.x) x = critter.x + critter.width + gap;
  if (x + panelSize.width > workArea.x + workArea.width) x = workArea.x + workArea.width - panelSize.width;
  let y = critter.y + critter.height - panelSize.height;
  y = Math.min(y, workArea.y + workArea.height - panelSize.height);
  y = Math.max(y, workArea.y);
  return { x: Math.round(x), y: Math.round(y) };
}

module.exports = { clampToDisplays, panelPosition, intersects };
