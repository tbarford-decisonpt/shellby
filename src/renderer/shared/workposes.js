// What he holds for each work pose (src/main/workpose.js picks the pose, the
// moves are in critter/beats.css), and the timing that keeps a pose up long
// enough to read. Shared by the desktop crab (critter/beats.js) and the OBS
// overlay (obs/overlay.js), so a stream sees him work the same way.
(function (root) {
  // In his claw, as sprite.js accessories: pivot is the pixel that sits in his pinch.
  const held = (pivot, palette, pixels) => ({ slot: 'held', anchor: 'claw', follows: 'claw', pivot, palette, pixels });
  const ITEMS = {
    read: held([0, 3], { b: '#a0693a', w: '#fff4e4', k: '#8d99ae' }, ['bbbbbb', '.wwww.', '.wkkw.', '.wwww.', '.wkkw.', 'bbbbbb']),
    write: held([1, 4], { e: '#ff8fa3', y: '#ffd23f', t: '#e9c89a', g: '#2b2d42' }, ['....ee', '...yye', '..yyy.', '.yyy..', 'tty...', 'gt....']),
    shell: held([1, 4], { s: '#cfd8dc', d: '#8d99ae' }, ['...s.s', '...dsd', '..sd..', '.sd...', 'sd....', 'd.....']),
    web: held([1, 1], { y: '#ffd23f', Y: '#c9a227', g: '#7fd6c2' }, ['..YYYY.', 'Yyyyyyg', '..YYYY.']),
    plan: held([0, 4], { K: '#4a4e69', b: '#a0693a', w: '#fff4e4', g: '#06d6a0', k: '#8d99ae' }, ['.KKK.', 'bwwwb', 'bgkkb', 'bwwwb', 'bgkkb', 'bbbbb']),
    call: null, // a wave: his claw is free
  };
  const POSES = Object.keys(ITEMS);

  // A pose holds for a moment before the next, so a burst of quick calls reads
  // as one job; the thinking between calls waits a little longer, so a pause of
  // a second between two edits doesn't drop the pencil. Leaving work entirely
  // puts it down at once, in time for whatever comes next.
  const MIN_MS = 1500;
  const GAP_MS = 900;

  /**
   * holder(show, { now, setTimeout, clearTimeout }) -> { set(pose, working), shown() }
   * show(pose, was) is called when the pose on screen changes (pose null: his scuttle).
   */
  function holder(show, opts = {}) {
    const now = opts.now || (() => Date.now());
    const later = opts.setTimeout || setTimeout;
    const cancel = opts.clearTimeout || clearTimeout;
    let shown = null;
    let shownAt = -Infinity;
    let want = null;
    let timer = null;

    function flip() {
      cancel(timer);
      timer = null;
      const was = shown;
      shown = want;
      shownAt = now();
      show(shown, was);
    }

    function set(pose, working) {
      want = working && Object.hasOwn(ITEMS, pose) ? pose : null;
      if (want === shown) { cancel(timer); timer = null; return; }
      if (!working) return flip();
      const wait = Math.max(shownAt + MIN_MS - now(), want ? 0 : GAP_MS);
      if (wait <= 0) return flip();
      cancel(timer);
      timer = later(flip, wait);
    }

    return { set, shown: () => shown };
  }

  root.ShellbyWorkPoses = { ITEMS, POSES, holder, MIN_MS, GAP_MS };
  if (typeof module !== 'undefined') module.exports = root.ShellbyWorkPoses;
})(typeof window !== 'undefined' ? window : globalThis);
