// How he works, in the renderer: what he holds for each pose (src/main/work-pose.js
// picks the pose, the moves are .work-<pose> in critter/critter.css), and the
// timing that keeps a pose up long enough to read. Shared by the desktop crab
// (critter/critter.js) and the OBS overlay (obs/overlay.js), so a stream sees
// him work the same way.
(function (root) {
  // In his claw, as sprite.js accessories: pivot is the pixel that sits in his pinch.
  const held = (pivot, palette, pixels) => ({ slot: 'held', anchor: 'claw', follows: 'claw', pivot, palette, pixels });
  const ITEMS = {
    think: null, // claw to his chin
    read: held([0, 3], { b: '#a0693a', w: '#fff4e4', k: '#8d99ae' }, ['bbbbbb', '.wwww.', '.wkkw.', '.wwww.', '.wkkw.', 'bbbbbb']),
    write: held([1, 4], { e: '#ff8fa3', y: '#ffd23f', t: '#e9c89a', g: '#2b2d42' }, ['....ee', '...yye', '..yyy.', '.yyy..', 'tty...', 'gt....']),
    run: held([1, 4], { s: '#cfd8dc', d: '#8d99ae' }, ['...s.s', '...dsd', '..sd..', '.sd...', 'sd....', 'd.....']),
    search: held([0, 5], { k: '#4a4e69', g: '#7fd6c2', w: '#e9fff7', b: '#a0693a' }, ['..kkk.', '.kgggk', '.kgwgk', '.kgggk', '.bkkk.', 'bb....']),
    web: held([1, 1], { y: '#ffd23f', Y: '#c9a227', g: '#7fd6c2' }, ['..YYYY.', 'Yyyyyyg', '..YYYY.']),
    plan: held([0, 4], { K: '#4a4e69', b: '#a0693a', w: '#fff4e4', g: '#06d6a0', k: '#8d99ae' }, ['.KKK.', 'bwwwb', 'bgkkb', 'bwwwb', 'bgkkb', 'bbbbb']),
    crew: null, // a wave: his claw is free
    busy: null, // the scuttle he always had
  };
  const POSES = Object.keys(ITEMS);

  // Claude can switch tools several times a second, so a pose holds for a
  // moment before the next takes over, and a burst of quick calls reads as one
  // job. Thinking between two calls waits a little longer still, so a pause of
  // a second between two edits doesn't put the pencil down. The first pose of a
  // turn shows at once, and leaving work puts it all down at once, in time for
  // whatever comes next.
  const MIN_MS = 1500;
  const GAP_MS = 900;

  /**
   * holder(show, { now, setTimeout, clearTimeout }) -> { set(pose, working), shown() }
   * show(pose, was) is called when the pose on screen changes (null: not working).
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
      if (!working || shown === null) return flip();
      const wait = Math.max(shownAt + MIN_MS - now(), want === 'think' ? GAP_MS : 0);
      if (wait <= 0) return flip();
      cancel(timer);
      timer = later(flip, wait);
    }

    return { set, shown: () => shown };
  }

  root.ShellbyWorkPoses = { ITEMS, POSES, holder, MIN_MS, GAP_MS };
  if (typeof module !== 'undefined') module.exports = root.ShellbyWorkPoses;
})(typeof window !== 'undefined' ? window : globalThis);
