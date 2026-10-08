// Gifts from digging. When he digs at your wallpaper, now and then he turns
// something up: sea glass, a lost key, a pearl, very rarely a gold doubloon.
// He holds it up, gives it to you, and it goes on the shelf (Shellby's screen →
// Finds). Some only turn up in their season, a couple only on special days,
// and they come in sets worth completing.
//
// Now and then one comes up sparkly: the same find in turned colours, with a
// glint (1 in 128, more during some tide events). The shelf counts them apart.
// Tide events (events.js) bring two finds each that only turn up while
// they're on.
//
// Pure: no I/O, no clock, no randomness of its own (callers pass `now` and
// `rand`). src/main/life.js does the digging; see test/gifts.test.js.
const art = require('./bugdex/art');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const RARITY = Object.freeze({
  common: { weight: 64, label: 'Common' },
  uncommon: { weight: 26, label: 'Uncommon' },
  rare: { weight: 8.5, label: 'Rare' },
  legendary: { weight: 1.5, label: 'Legendary' },
  special: { weight: 0, label: 'Keepsake' },
});

const DIG_CHANCE = 0.2;            // an idle dig that turns something up
const DRY_SPELL = 6;               // ...and after this many empty digs in a row, one always does
const DAILY_CAP = 5;               // idle finds a day; a manual dig is on top
const FIND_GAP = 20 * MINUTE;      // between idle finds
const MANUAL_EVERY = 2 * HOUR;     // "Dig for treasure" from his menu
const LEGENDARY_AFTER = 10;        // finds before a legendary can turn up at all
const NEW_BIAS = 2;                // something not on the shelf yet is this much likelier
const EVENT_BIAS = 6;              // a tide event's own finds, while it's on
const SPARKLE_CHANCE = 1 / 128;    // a sparkly one (events.js can raise it, at most 4×)
const MAX_SPARKLE_BOOST = 4;

// Each find: pixel art (one character per pixel, '.' is empty), a line for the
// shelf, and where it belongs. `season` finds only turn up in that season
// (src/main/wardrobe/seasons.js), `event` ones only during their tide event
// (events.js), `night` ones only after dark, `special` ones only on their day.
const FINDS = Object.freeze([
  // ---- the beach
  { id: 'pebble', name: 'Smooth pebble', rarity: 'common', set: 'beach', blurb: 'Perfectly round. He checked.', palette: { a: '#8d99ae', b: '#b8c2d1', c: '#dfe5ec' }, pixels: ['.bbb.', 'bcbba', 'bbbba', '.aaa.'] },
  { id: 'sand-dollar', name: 'Sand dollar', rarity: 'common', set: 'beach', blurb: 'Not legal tender. He asked.', palette: { a: '#f3e6cc', b: '#c9b38a' }, pixels: ['.aaa.', 'aabaa', 'abbba', 'aabaa', '.aaa.'] },
  { id: 'tiny-shell', name: 'Tiny shell', rarity: 'common', set: 'beach', blurb: 'Too small to live in. For now.', palette: { a: '#ff9f80', b: '#ffd2c2' }, pixels: ['..a..', '.aba.', 'ababa', 'aaaaa'] },
  { id: 'driftwood', name: 'Driftwood', rarity: 'common', set: 'beach', blurb: 'Washed up from somewhere far away.', palette: { a: '#8a6a4a', b: '#b89470' }, pixels: ['ab....', '.aab..', '..abba', '....ab'] },
  { id: 'kelp', name: 'Bit of kelp', rarity: 'common', set: 'beach', blurb: 'Smells like home.', palette: { a: '#2a9d8f', b: '#57cc99' }, pixels: ['.a', 'ab', 'a.', 'ab', '.a'] },
  { id: 'starfish', name: 'Starfish', rarity: 'uncommon', set: 'beach', blurb: 'Waved at him first.', palette: { a: '#ff7a5c', b: '#ffb199' }, pixels: ['..a..', 'aabaa', '.aba.', 'a...a'] },
  { id: 'urchin-shell', name: 'Urchin shell', rarity: 'common', set: 'beach', blurb: 'Spikes gone. Still a bit grumpy.', palette: { a: '#9d4edd', b: '#c77dff' }, pixels: ['a.a.a', '.bbb.', 'abbba', '.bbb.', 'a.a.a'] },
  { id: 'conch', name: 'Conch shell', rarity: 'uncommon', set: 'beach', blurb: 'Hold it to your ear: the sea. Or your laptop fan.', palette: { a: '#ffb4a2', b: '#e5989b', c: '#fff1e6' }, pixels: ['..aa.', '.abaa', 'abbca', '.aaa.'] },

  // ---- sea glass: one of each colour
  { id: 'sea-glass-green', name: 'Green sea glass', rarity: 'common', set: 'sea-glass', blurb: 'An old bottle, worn smooth by the tide.', palette: { a: '#57cc99', b: '#c8f3e8' }, pixels: ['.ab.', 'aaab', '.aa.'] },
  { id: 'sea-glass-blue', name: 'Blue sea glass', rarity: 'uncommon', set: 'sea-glass', blurb: 'The colour of the deep end.', palette: { a: '#4ea8de', b: '#cdeafe' }, pixels: ['.ab.', 'aaab', '.aa.'] },
  { id: 'sea-glass-amber', name: 'Amber sea glass', rarity: 'uncommon', set: 'sea-glass', blurb: 'Glows when the sun hits it.', palette: { a: '#e9a23b', b: '#fde6b8' }, pixels: ['.ab.', 'aaab', '.aa.'] },
  { id: 'sea-glass-red', name: 'Red sea glass', rarity: 'rare', set: 'sea-glass', blurb: 'The rarest colour there is. He knows.', palette: { a: '#e63946', b: '#ffccd5' }, pixels: ['.ab.', 'aaab', '.aa.'] },

  // ---- down the back of your desk
  { id: 'paperclip', name: 'Paperclip', rarity: 'common', set: 'junk-drawer', blurb: 'Bent. Probably by you.', palette: { a: '#a8b2c1' }, pixels: ['.aaa.', 'a.a.a', 'a.a.a', 'a...a', '.aaa.'] },
  { id: 'rubber-band', name: 'Rubber band', rarity: 'common', set: 'junk-drawer', blurb: 'Not for flicking. Not at him.', palette: { a: '#c97b4a' }, pixels: ['.aaa.', 'a...a', 'a...a', '.aaa.'] },
  { id: 'button', name: 'Lost button', rarity: 'common', set: 'junk-drawer', blurb: 'From a shirt you no longer own.', palette: { a: '#7fb3ff', b: '#2b4a7a' }, pixels: ['.aa.', 'abba', 'abba', '.aa.'] },
  { id: 'bottle-cap', name: 'Bottle cap', rarity: 'common', set: 'junk-drawer', blurb: 'Crimped edges, very satisfying.', palette: { a: '#e63946', b: '#ffd6d9' }, pixels: ['.aaa.', 'abbba', 'aaaaa'] },
  { id: 'lost-key', name: 'Lost key', rarity: 'uncommon', set: 'junk-drawer', blurb: 'Opens something. Nobody knows what.', palette: { a: '#e2b13c' }, pixels: ['.aa.....', 'a..aaaaa', '.aa..a.a'] },
  { id: 'guitar-pick', name: 'Guitar pick', rarity: 'uncommon', set: 'junk-drawer', blurb: 'He has no guitar. He has ambitions.', palette: { a: '#9d4edd', b: '#c77dff' }, pixels: ['aaaaa', 'abbba', '.aba.', '..a..'] },
  { id: 'usb-stick', name: 'USB stick', rarity: 'uncommon', set: 'junk-drawer', blurb: 'Labelled "backup FINAL 2". Not plugged in.', palette: { a: '#3d405b', b: '#c0c0c0' }, pixels: ['.bb.', '.bb.', 'aaaa', 'aaaa', 'aaaa'] },
  { id: 'safety-pin', name: 'Safety pin', rarity: 'common', set: 'junk-drawer', blurb: 'Holding nothing together. Yet.', palette: { a: '#c0c0c0' }, pixels: ['aaaaaa', 'a....a', '.aaaa.'] },
  { id: 'battery', name: 'Mystery battery', rarity: 'common', set: 'junk-drawer', blurb: 'Dead? Alive? Only the remote knows.', palette: { a: '#2b2d42', b: '#ffd23f', c: '#c0c0c0' }, pixels: ['.c.', 'aaa', 'aaa', 'bbb', 'bbb'] },
  { id: 'sticky-note', name: 'Sticky note', rarity: 'common', set: 'junk-drawer', blurb: 'Says "DON\'T FORGET". Doesn\'t say what.', palette: { a: '#ffe066', b: '#c9a227' }, pixels: ['aaaa', 'abba', 'aaaa', 'abaa'] },

  // ---- the toy box
  { id: 'metal-jack', name: 'Metal jack', rarity: 'common', set: 'toy-box', blurb: 'Do not step on. He learned.', palette: { a: '#c0c0c0' }, pixels: ['a...a', '.a.a.', '..a..', '.a.a.', 'a...a'] },
  { id: 'toy-brick', name: 'Toy brick', rarity: 'common', set: 'toy-box', blurb: 'Nobody has stepped on it. Yet.', palette: { a: '#e63946', b: '#ff8f8f' }, pixels: ['.b.b.', 'aaaaa', 'aaaaa'] },
  { id: 'lucky-die', name: 'Lucky die', rarity: 'common', set: 'toy-box', blurb: 'Always lands on six. When he\'s looking.', palette: { w: '#fff4e4', k: '#2b2d42' }, pixels: ['wwwww', 'wkwkw', 'wwwww', 'wkwkw', 'wwwww'] },
  { id: 'marble', name: 'Marble', rarity: 'uncommon', set: 'toy-box', blurb: 'He lost his once. This one is yours.', palette: { a: '#4361ee', b: '#f72585', c: '#ffffff' }, pixels: ['.aa.', 'abca', 'acba', '.aa.'] },
  { id: 'yo-yo', name: 'Yo-yo', rarity: 'uncommon', set: 'toy-box', blurb: 'Walks the dog. There is no dog.', palette: { a: '#3a86ff', b: '#cdeafe', s: '#ffffff' }, pixels: ['s...', '.aa.', 'abba', '.aa.'] },
  { id: 'toy-car', name: 'Toy car', rarity: 'uncommon', set: 'toy-box', blurb: 'Goes vroom. He supplies the vroom.', palette: { r: '#ff5a4a', c: '#cdeafe', k: '#2b2d42' }, pixels: ['.rc..', 'rrrrr', '.k.k.'] },
  { id: 'wind-up-crab', name: 'Wind-up crab', rarity: 'rare', set: 'toy-box', blurb: 'A tiny tin crab. He\'s not sure how to feel.', palette: { r: '#ff7a5c', k: '#3d405b', y: '#ffd23f' }, pixels: ['..y..', 'r.y.r', 'rrrrr', '.k.k.'] },

  // ---- lost in the codebase
  { id: 'lost-semicolon', name: 'Lost semicolon', rarity: 'common', set: 'codebase', blurb: 'So that\'s where it went. Line 212.', palette: { a: '#c77dff' }, pixels: ['aa', 'aa', '..', 'aa', '.a', 'a.'] },
  { id: 'stray-bracket', name: 'Stray bracket', rarity: 'common', set: 'codebase', blurb: 'Closes nothing. Opened nothing. At peace.', palette: { a: '#ffd23f' }, pixels: ['.aa', '.a.', '.a.', 'a..', '.a.', '.a.', '.aa'] },
  { id: 'coffee-bean', name: 'Coffee bean', rarity: 'common', set: 'codebase', blurb: 'Fell out of your third cup.', palette: { a: '#6f4518', b: '#3b2412' }, pixels: ['.aa.', 'abaa', 'aaba', '.aa.'] },
  { id: 'escape-key', name: 'Escape key', rarity: 'uncommon', set: 'codebase', blurb: 'You pressed it so hard it came off.', palette: { a: '#e0e0e0', b: '#9e9e9e', c: '#3d405b' }, pixels: ['aaaaa', 'accca', 'aaaaa', 'bbbbb'] },
  { id: 'floppy-disk', name: 'Floppy disk', rarity: 'uncommon', set: 'codebase', blurb: '1.44 MB. He\'s saving it for something big.', palette: { a: '#3a86ff', b: '#c0c0c0', c: '#fff4e4' }, pixels: ['abbaa', 'abbaa', 'aaaaa', 'accca', 'accca'] },
  { id: 'actual-bug', name: 'Actual bug', rarity: 'rare', set: 'codebase', blurb: 'Six legs. Not in your code, for once.', palette: { a: '#2a9d8f', b: '#1b4332' }, pixels: ['a...a', '.bbb.', 'abbba', '.bbb.', 'a...a'] },
  { id: 'rubber-duck', name: 'Rubber duck', rarity: 'rare', set: 'codebase', blurb: 'Tell it your problem. It listens.', palette: { y: '#ffd23f', o: '#ff9f1c', k: '#2b2d42' }, pixels: ['..yy..', '..yko.', 'yyyyy.', '.yyyy.'] },
  { id: 'golden-duck', name: 'Golden rubber duck', rarity: 'legendary', set: 'codebase', blurb: 'Answers your questions too. Only in riddles.', palette: { a: '#c99700', b: '#ffd23f', k: '#2b2d42' }, pixels: ['..bb..', '..bka.', 'abbbb.', '.aaaa.'] },

  // ---- the back garden
  { id: 'ladybird', name: 'Ladybird', rarity: 'common', set: 'garden', blurb: 'He counted her spots. Lost count.', palette: { r: '#e63946', k: '#2b2d42' }, pixels: ['..k..', 'rrkrr', 'rkrkr', '.rrr.'] },
  { id: 'feather', name: 'Feather', rarity: 'common', set: 'garden', blurb: 'A bird lost it. A crab has it now.', palette: { a: '#8ecae6', b: '#219ebc' }, pixels: ['...a', '..ab', '.ab.', 'ab..', 'b...'] },
  { id: 'daisy', name: 'Daisy', rarity: 'common', set: 'garden', blurb: 'Loves you. He checked every petal.', palette: { w: '#ffffff', y: '#ffd23f', g: '#57cc99' }, pixels: ['.w.', 'wyw', '.w.', '.g.', '.g.'] },
  { id: 'snail-shell', name: 'Empty snail shell', rarity: 'common', set: 'garden', blurb: 'He tried it on. Bit snug.', palette: { a: '#c97b4a', b: '#f3d9b1' }, pixels: ['.aaa.', 'ab.ba', 'a.a.a', 'abaa.'] },
  { id: 'seed-packet', name: 'Seed packet', rarity: 'uncommon', set: 'garden', blurb: 'Says "giant sunflowers". He\'s hopeful.', palette: { a: '#fde6b8', b: '#ffd23f', c: '#57cc99' }, pixels: ['aaaa', 'abba', 'abba', 'acca', 'aaaa'] },
  { id: 'gnome-hat', name: 'Tiny gnome hat', rarity: 'uncommon', set: 'garden', blurb: 'The gnome says it\'s fine. The gnome is lying.', palette: { r: '#e63946' }, pixels: ['..r..', '.rrr.', 'rrrrr'] },
  { id: 'four-leaf-clover', name: 'Four-leaf clover', rarity: 'rare', set: 'garden', blurb: 'Lucky. He\'s been luckier ever since.', palette: { a: '#2a9d8f', b: '#57cc99' }, pixels: ['bb.bb', 'bbabb', '..a..', 'bbabb', 'bb.bb'] },

  // ---- the dig site
  { id: 'pottery-shard', name: 'Pottery shard', rarity: 'common', set: 'dig-site', blurb: 'Someone\'s favourite mug, once.', palette: { a: '#c97b4a', b: '#e9a26a' }, pixels: ['aaab', 'abb.', 'ab..'] },
  { id: 'rusty-nail', name: 'Rusty nail', rarity: 'common', set: 'dig-site', blurb: 'Older than the house it fell out of.', palette: { a: '#8a4b2a' }, pixels: ['aaa', '.a.', '.a.', '.a.'] },
  { id: 'arrowhead', name: 'Arrowhead', rarity: 'uncommon', set: 'dig-site', blurb: 'Chipped by hand, a very long time ago.', palette: { a: '#6c757d', b: '#adb5bd' }, pixels: ['..a..', '.aba.', '.aba.', 'aabaa', '..a..'] },
  { id: 'trilobite', name: 'Trilobite', rarity: 'rare', set: 'dig-site', blurb: 'Was here first. Doesn\'t like to bring it up.', palette: { a: '#8d6e63', b: '#bcaaa4' }, pixels: ['.aaa.', 'abbba', 'aaaaa', 'abbba', '.aaa.', '..a..'] },
  { id: 'bug-in-amber', name: 'Bug in amber', rarity: 'rare', set: 'dig-site', blurb: 'It waited 40 million years to meet him.', palette: { a: '#e9a23b', b: '#fde6b8', k: '#5d4037' }, pixels: ['.aa.', 'abka', 'akka', '.aa.'] },
  { id: 'dino-tooth', name: 'Dinosaur tooth', rarity: 'legendary', set: 'dig-site', blurb: 'Older than every crab there has ever been.', palette: { a: '#f1faee', b: '#d6ccc2' }, pixels: ['aaaa', 'aaab', '.aab', '.ab.', '.a..'] },

  // ---- a pirate's hoard
  { id: 'old-coin', name: 'Old coin', rarity: 'uncommon', set: 'pirate', blurb: 'A king nobody remembers.', palette: { a: '#b08d57', b: '#d4b483' }, pixels: ['.aaa.', 'abbba', 'ababa', 'abbba', '.aaa.'] },
  { id: 'compass', name: 'Compass', rarity: 'rare', set: 'pirate', blurb: 'Always points at the snacks.', palette: { a: '#b08d57', b: '#fff4e4', r: '#e63946', w: '#3d405b' }, pixels: ['.aaa.', 'abrba', 'abwba', 'abbba', '.aaa.'] },
  { id: 'tiny-anchor', name: 'Tiny anchor', rarity: 'rare', set: 'pirate', blurb: 'From a very small ship.', palette: { a: '#577590' }, pixels: ['..a..', '.aaa.', '..a..', 'a.a.a', '.aaa.'] },
  { id: 'message-bottle', name: 'Message in a bottle', rarity: 'rare', set: 'pirate', blurb: 'It says "hi". That\'s all it says.', palette: { a: '#8a6a4a', c: '#a8dadc', d: '#fff4e4' }, pixels: ['..a..', '..c..', '.ccc.', '.cdc.', '.ccc.'] },
  { id: 'treasure-map', name: 'Torn treasure map', rarity: 'legendary', set: 'pirate', blurb: 'X marks the spot. The spot is your desk.', palette: { a: '#e9d8a6', b: '#c9b38a', c: '#e63946' }, pixels: ['aaaaa', 'abcba', 'acbba', 'aaaaa'] },
  { id: 'eyepatch', name: 'Eyepatch', rarity: 'uncommon', set: 'pirate', blurb: 'He doesn\'t need it. He wears it anyway.', palette: { k: '#2b2d42' }, pixels: ['k....', '.k...', '..kkk', '..kkk'] },
  { id: 'spyglass', name: 'Spyglass', rarity: 'rare', set: 'pirate', blurb: 'Everything far away is a little closer now.', palette: { a: '#b08d57', b: '#8a6a4a', c: '#a8dadc' }, pixels: ['caabbb', 'caabbb'] },
  { id: 'gold-doubloon', name: 'Gold doubloon', rarity: 'legendary', set: 'pirate', blurb: 'Real gold. He bit it to check.', palette: { a: '#c99700', b: '#ffd23f', c: '#fff4b3' }, pixels: ['.aaa.', 'abbba', 'abcba', 'abbba', '.aaa.'] },

  // ---- from the deep
  { id: 'pearl', name: 'Pearl', rarity: 'rare', set: 'deep', blurb: 'An oyster worked very hard on this.', palette: { a: '#f8f4ff', b: '#cfc6e6' }, pixels: ['.aa.', 'aaab', '.bb.'] },
  { id: 'shark-tooth', name: 'Shark tooth', rarity: 'rare', set: 'deep', blurb: 'The shark has others. Probably.', palette: { a: '#f1faee', b: '#cfd8dc' }, pixels: ['aaaaa', '.abb.', '.ab..', '..a..'] },
  { id: 'ammonite', name: 'Ammonite fossil', rarity: 'rare', set: 'deep', blurb: 'Older than the dinosaurs. Older than him, even.', palette: { a: '#a1887f', b: '#d7ccc8' }, pixels: ['.aaaa.', 'ab..ba', 'ab.a.a', 'a.aa.a', '.aaaa.'] },
  { id: 'moon-shell', name: 'Moon shell', rarity: 'rare', set: 'deep', night: true, blurb: 'Only shows itself after dark.', palette: { a: '#cfd8ff', b: '#9fb0ff', c: '#ffffff' }, pixels: ['.aaa.', 'abbba', 'abcba', 'abbba', '.aaa.'] },
  { id: 'ships-bell', name: 'Ship\'s bell', rarity: 'rare', set: 'deep', blurb: 'Rings once a year. Nobody knows for whom.', palette: { a: '#c99700', b: '#ffd23f' }, pixels: ['..a..', '.bbb.', '.bbb.', 'bbbbb', '..a..'] },
  { id: 'black-pearl', name: 'Black pearl', rarity: 'legendary', set: 'deep', blurb: 'One in ten thousand oysters. He found it in your wallpaper.', palette: { a: '#2b2d42', b: '#8d99ae' }, pixels: ['.aa.', 'aaab', '.bb.'] },
  { id: 'mermaid-comb', name: 'Mermaid\'s comb', rarity: 'legendary', set: 'deep', blurb: 'She\'ll want it back.', palette: { a: '#ffd23f', b: '#7fd6c2' }, pixels: ['abababa', 'aaaaaaa', '.bbbbb.'] },

  // ---- after dark: only at night
  { id: 'glow-stick', name: 'Glow stick', rarity: 'common', set: 'night', night: true, blurb: 'Still glowing from a party he missed.', palette: { a: '#80ffdb', b: '#c8fff0' }, pixels: ['..a', '.ab', 'ab.', 'a..'] },
  { id: 'moth', name: 'Moth', rarity: 'common', set: 'night', night: true, blurb: 'Was looking for your monitor.', palette: { a: '#b5a48b', b: '#7f6f58' }, pixels: ['aa.aa', 'aabaa', '.a.a.'] },
  { id: 'firefly-jar', name: 'Firefly jar', rarity: 'uncommon', set: 'night', night: true, blurb: 'He let them go after. Mostly.', palette: { g: '#a8dadc', y: '#ffd23f', k: '#8a6a4a' }, pixels: ['.kkk.', 'g...g', 'g.y.g', 'gy..g', 'ggggg'] },
  { id: 'owl-feather', name: 'Owl feather', rarity: 'uncommon', set: 'night', night: true, blurb: 'Silent, even when it falls.', palette: { a: '#a1887f', b: '#5d4037' }, pixels: ['..a', '.ab', 'aba', 'ba.', 'b..'] },
  { id: 'moonstone', name: 'Moonstone', rarity: 'rare', set: 'night', night: true, blurb: 'Cold and pale. Warms up in his claw.', palette: { a: '#dfe7fd', b: '#a5b4fc', c: '#ffffff' }, pixels: ['.aa.', 'acab', 'abbb', '.bb.'] },
  { id: 'fallen-star', name: 'Fallen star', rarity: 'legendary', set: 'night', night: true, blurb: 'Made a wish on the way down. Won\'t say what.', palette: { y: '#ffd23f', w: '#fff4b3' }, pixels: ['..y..', '.ywy.', 'yywyy', '.yyy.', 'y...y'] },

  // ---- odds and ends
  { id: 'fortune-cookie', name: 'Fortune cookie', rarity: 'uncommon', blurb: 'It says "You will meet a crab." Spooky.', palette: { a: '#e9a23b', b: '#fde6b8' }, pixels: ['.aaa.', 'abbba', 'aa.aa'] },
  { id: 'tiny-pumpkin', name: 'Tiny pumpkin', rarity: 'uncommon', season: 'halloween', blurb: 'Carved with a very small, very smug face.', palette: { o: '#ff9f1c', g: '#2a9d8f', k: '#2b2d42' }, pixels: ['..g..', 'ooooo', 'okoko', 'ooooo'] },
  { id: 'lost-mitten', name: 'Lost mitten', rarity: 'uncommon', season: 'winter', blurb: 'The other one is still out there.', palette: { r: '#e63946', w: '#fff4e4' }, pixels: ['.rrr.', 'rrrr.', '.rrr.', '.www.'] },
  { id: 'candy-heart', name: 'Candy heart', rarity: 'uncommon', season: 'valentine', blurb: 'It says BE MINE. He\'s thinking about it.', palette: { p: '#ffb3c6', k: '#ff5d8f' }, pixels: ['.p.p.', 'ppppp', 'pkkkp', '.ppp.', '..p..'] },
  { id: 'robin-egg', name: 'Robin\'s egg', rarity: 'uncommon', season: 'spring', blurb: 'Empty. Someone hatched and flew off.', palette: { a: '#9bf6ff', b: '#6fd3e0' }, pixels: ['.aa.', 'aaba', 'abaa', '.aa.'] },
  { id: 'lolly-stick', name: 'Lolly stick', rarity: 'uncommon', season: 'summer', blurb: 'Half a joke on it. He\'s still wondering.', palette: { a: '#e9d8a6' }, pixels: ['aa', 'aa', 'aa', 'aa', 'aa'] },
  { id: 'red-leaf', name: 'Red maple leaf', rarity: 'uncommon', season: 'autumn', blurb: 'The reddest one. Took him ages.', palette: { r: '#d62828', b: '#9d0208' }, pixels: ['..r..', 'r.r.r', 'rrrrr', '.rrr.', '..b..'] },

  // ---- all year round: one per season
  { id: 'candy-corn', name: 'Candy corn', rarity: 'uncommon', set: 'seasons', season: 'halloween', blurb: 'Divisive. He likes it.', palette: { w: '#fff4e4', o: '#ff9f1c', y: '#ffd23f' }, pixels: ['..w..', '.ooo.', 'ooooo', 'yyyyy'] },
  { id: 'snowflake', name: 'Snowflake ornament', rarity: 'uncommon', set: 'seasons', season: 'winter', blurb: 'Doesn\'t melt. He tried.', palette: { a: '#e0fbfc' }, pixels: ['a.a.a', '.aaa.', 'aa.aa', '.aaa.', 'a.a.a'] },
  { id: 'heart-locket', name: 'Heart locket', rarity: 'uncommon', set: 'seasons', season: 'valentine', blurb: 'There\'s a tiny crab inside.', palette: { a: '#ff8fab', b: '#fff4f7' }, pixels: ['.a.a.', 'aaaaa', 'abaaa', '.aaa.', '..a..'] },
  { id: 'painted-egg', name: 'Painted egg', rarity: 'uncommon', set: 'seasons', season: 'spring', blurb: 'Not his. He\'s keeping it anyway.', palette: { a: '#b8f2e6', b: '#ff8fab', c: '#ffd166' }, pixels: ['.aa.', 'abba', 'aaaa', 'acca', '.aa.'] },
  { id: 'beach-ball', name: 'Beach ball', rarity: 'uncommon', set: 'seasons', season: 'summer', blurb: 'Bigger than him when it\'s blown up.', palette: { a: '#ff5a4a', b: '#fff4e4', c: '#3a86ff' }, pixels: ['.abc.', 'abcab', 'cabca', '.bca.'] },
  { id: 'acorn', name: 'Acorn', rarity: 'uncommon', set: 'seasons', season: 'autumn', blurb: 'A squirrel is looking for this.', palette: { a: '#c97b4a', b: '#7f5539' }, pixels: ['.bbb.', 'bbbbb', '.aaa.', '.aaa.', '..a..'] },

  // ---- tide events: two each, only while the event is on (events.js)
  { id: 'golden-wheat', name: 'Golden wheat', rarity: 'rare', set: 'tides', event: 'harvest', blurb: 'From the last field before the moon came up.', palette: { y: '#ffd166', Y: '#e9a23b', g: '#8a6a3a' }, pixels: ['.y.y.', 'yYyYy', '.yYy.', '..g..', '..g..', '.g.g.'] },
  { id: 'lantern-gourd', name: 'Lantern gourd', rarity: 'rare', set: 'tides', event: 'harvest', blurb: 'Hollowed out, with a light inside. Still warm.', palette: { o: '#e76f51', y: '#ffd166', s: '#3a7d44' }, pixels: ['..s..', '.ooo.', 'oyoyo', 'ooyoo', '.ooo.'] },
  { id: 'ghost-lantern', name: 'Ghost lantern', rarity: 'rare', set: 'tides', event: 'haunting', blurb: 'Glows green. Nobody lit it.', palette: { k: '#2b2d42', g: '#57cc99', G: '#b8ffd9' }, pixels: ['.kkk.', 'k.k.k', 'kgGgk', 'kGgGk', 'kgGgk', '.kkk.'] },
  { id: 'cursed-doubloon', name: 'Cursed doubloon', rarity: 'rare', set: 'tides', event: 'haunting', blurb: 'Every time he puts it down it\'s back in his claw.', palette: { a: '#9bb34a', b: '#e0e78f', k: '#2b2d42' }, pixels: ['.aaa.', 'abkba', 'abbba', 'akbka', '.aaa.'] },
  { id: 'ice-crystal', name: 'Ice crystal', rarity: 'rare', set: 'tides', event: 'frostbite', blurb: 'From a tide pool that froze solid. Doesn\'t melt.', palette: { i: '#8ecae6', w: '#ffffff' }, pixels: ['..w..', '.iwi.', 'iiwii', '.iwi.', '..i..'] },
  { id: 'frozen-bug', name: 'Bug in ice', rarity: 'rare', set: 'tides', event: 'frostbite', blurb: 'Caught in the ice before anyone could fix it.', palette: { i: '#cdeafe', I: '#8ecae6', r: '#e63946', k: '#2b2d42' }, pixels: ['IIIII', 'IirkI', 'IrrrI', 'IikiI', 'IIIII'] },
  { id: 'love-letter', name: 'Love letter', rarity: 'rare', set: 'tides', event: 'penpal', blurb: 'Addressed to "the crab on the next desk".', palette: { w: '#fff4e4', b: '#c9b38a', r: '#ff5d8f' }, pixels: ['bbbbbb', 'bwbbwb', 'bwwwwb', 'bwwrwb', 'bbbbbb'] },
  { id: 'paired-shells', name: 'Paired shells', rarity: 'rare', set: 'tides', event: 'penpal', blurb: 'Two halves of one shell. He keeps one, you keep one.', palette: { a: '#ffb3c6', b: '#ff8fab', c: '#fff4f7' }, pixels: ['.aa..bb.', 'acaa.bcb', 'aaaa.bbb', '.aa...b.'] },
  { id: 'feather-duster', name: 'Feather duster', rarity: 'rare', set: 'tides', event: 'spring-clean', blurb: 'For the corners of the codebase nobody visits.', palette: { p: '#ffb3c6', y: '#ffd166', b: '#8a6a4a' }, pixels: ['pyp', 'ypy', 'pyp', '.b.', '.b.', '.b.'] },
  { id: 'pressed-flower', name: 'Pressed flower', rarity: 'rare', set: 'tides', event: 'spring-clean', blurb: 'Found between the pages of an old README.', palette: { p: '#ff8fab', y: '#ffd166', g: '#57cc99', w: '#fff4e4' }, pixels: ['wwwww', 'wpwpw', 'wwyww', 'wpgpw', 'wwgww'] },
  { id: 'stranded-jelly', name: 'Stranded jellyfish', rarity: 'rare', set: 'tides', event: 'low-tide', blurb: 'The sea went out without it. He put it in a bucket.', palette: { p: '#cdb4db', P: '#9d4edd', w: '#fff4e4' }, pixels: ['.ppp.', 'pwpwp', 'PPPPP', 'P.P.P', '.P.P.'] },
  { id: 'pearl-oyster', name: 'Pearl oyster', rarity: 'rare', set: 'tides', event: 'low-tide', blurb: 'Left high and dry by the tide. The pearl is still in it.', palette: { a: '#8d99ae', b: '#c0c8d6', w: '#ffffff' }, pixels: ['.aaa.', 'abbba', 'a.w.a', 'abbba', '.aaa.'] },

  // ---- keepsakes: only on their day
  { id: 'cake-slice', name: 'Birthday cake', rarity: 'special', special: 'birthday', blurb: 'Dug up on your birthday. Still fresh, somehow.', palette: { r: '#e63946', w: '#fff4e4', p: '#f4a261' }, pixels: ['...r.', '..www', '.wwwp', 'wwwpp', 'ppppp'] },
  { id: 'hatch-candle', name: 'Hatch-day candle', rarity: 'special', special: 'hatchday', blurb: 'From the anniversary of the day he moved in.', palette: { y: '#ffd23f', o: '#ff9f1c', w: '#fff4e4', p: '#ff8fab' }, pixels: ['..y..', '..o..', '.www.', '.wpw.', '.www.'] },
].map(f => Object.freeze({ set: null, season: null, event: null, night: false, special: null, ...f, pixels: Object.freeze([...f.pixels]), palette: Object.freeze({ ...f.palette }) })));

const SETS = Object.freeze([
  { id: 'beach', name: 'Beach day', icon: '🏖️' },
  { id: 'sea-glass', name: 'Sea glass rainbow', icon: '🌈' },
  { id: 'junk-drawer', name: 'Junk drawer', icon: '🗃️' },
  { id: 'pirate', name: 'Pirate\'s hoard', icon: '🏴‍☠️' },
  { id: 'deep', name: 'From the deep', icon: '🐚' },
  { id: 'toy-box', name: 'Toy box', icon: '🧸' },
  { id: 'codebase', name: 'Lost in the codebase', icon: '💻' },
  { id: 'garden', name: 'Back garden', icon: '🌿' },
  { id: 'dig-site', name: 'Dig site', icon: '🦴' },
  { id: 'night', name: 'After dark', icon: '🌙' },
  { id: 'seasons', name: 'All year round', icon: '🗓️' },
  { id: 'tides', name: 'Tide chest', icon: '🧭' },
].map(s => Object.freeze({ ...s, members: Object.freeze(FINDS.filter(f => f.set === s.id).map(f => f.id)) })));

const BY_ID = new Map(FINDS.map(f => [f.id, f]));
const findById = id => BY_ID.get(id) || null;

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const pos = v => (Number.isFinite(v) && v > 0 ? v : 0);

/** Tolerate anything read from disk. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const items = {};
  for (const [id, it] of Object.entries(r.items && typeof r.items === 'object' ? r.items : {})) {
    if (!BY_ID.has(id) || !it || typeof it !== 'object') continue;
    const n = Math.floor(pos(it.n));
    if (!n) continue;
    const shiny = Math.min(n, Math.floor(pos(it.shiny)));
    // Set aside for a swap (swaps.js): never more than you have.
    const held = Math.min(n, Math.floor(pos(it.held)));
    const heldShiny = Math.min(shiny, held, Math.floor(pos(it.heldShiny)));
    items[id] = { n, first: pos(it.first), last: pos(it.last), ...(shiny ? { shiny, shinyFirst: pos(it.shinyFirst) } : {}), ...(held ? { held } : {}), ...(heldShiny ? { heldShiny } : {}) };
  }
  return {
    items,
    digs: Math.floor(pos(r.digs)),
    dry: Math.floor(pos(r.dry)),
    day: typeof r.day === 'string' ? r.day : null,
    today: Math.floor(pos(r.today)),
    lastFindAt: pos(r.lastFindAt),
    lastManualAt: pos(r.lastManualAt),
    specials: (Array.isArray(r.specials) ? r.specials : []).filter(s => typeof s === 'string' && /^[a-z]+:\d{4}$/.test(s)).slice(-20),
    favourite: BY_ID.has(r.favourite) && items[r.favourite] ? r.favourite : null,
    unseen: (Array.isArray(r.unseen) ? r.unseen : []).filter(id => items[id]).slice(-60),
  };
}

const total = state => Object.values(state.items).reduce((n, it) => n + it.n, 0);
const kinds = state => Object.keys(state.items).length;

/** Every find that could turn up right now, given the moment. */
function eligible(state, { seasons = [], night = false, special = null, event = null } = {}) {
  if (special) return FINDS.filter(f => f.special === special);
  const legendaryOk = total(state) >= LEGENDARY_AFTER;
  return FINDS.filter(f => !f.special
    && (!f.season || seasons.includes(f.season))
    && (!f.event || f.event === event)
    && (!f.night || night)
    && (f.rarity !== 'legendary' || legendaryOk));
}

/** One find, weighted by rarity, with a nudge toward what's not on the shelf yet. */
function pickFind(state, ctx, rand = Math.random) {
  const pool = eligible(state, ctx);
  if (!pool.length) return null;
  const weights = pool.map(f => (RARITY[f.rarity].weight || 1) * (state.items[f.id] ? 1 : NEW_BIAS) * (f.event ? EVENT_BIAS : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = rand() * sum;
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r < 0) return pool[i]; }
  return pool[pool.length - 1];
}

function add(state, find, t, shiny = false) {
  const it = state.items[find.id];
  const day = dayKey(t);
  const sparkle = shiny ? { shiny: (it?.shiny || 0) + 1, shinyFirst: it?.shinyFirst || t } : it?.shiny ? { shiny: it.shiny, shinyFirst: it.shinyFirst } : {};
  return {
    ...state,
    items: { ...state.items, [find.id]: { n: (it?.n || 0) + 1, first: it?.first || t, last: t, ...sparkle, ...(it?.held ? { held: it.held } : {}), ...(it?.heldShiny ? { heldShiny: it.heldShiny } : {}) } },
    dry: 0,
    lastFindAt: t,
    unseen: [...state.unseen.filter(id => id !== find.id), find.id].slice(-60),
    day,
    today: state.day === day ? state.today : 0,
  };
}

/**
 * He dug. Did he find anything? Returns { state, find, isNew, completed, shiny, firstShiny }:
 * `find` is a FINDS entry or null, `isNew` whether it's the first of its kind,
 * `completed` the sets this find just finished, `shiny` whether it sparkles
 * (`firstShiny`: the first sparkly one of that find).
 *   ctx: { seasons: ['autumn'], night, manual, event, digBoost, shinyBoost }
 *   `manual` is "Dig for treasure" from his menu: it always finds something, on
 *   its own cooldown. `event` is the tide event going on; its boosts raise
 *   the odds of a find (at most 2×) and of a sparkly (at most 4×).
 */
function dig(stateIn, ctx = {}, now, rand = Math.random) {
  const state = normalize(stateIn);
  const t = Number(now);
  const nothing = s => ({ state: s, find: null, isNew: false, completed: [], shiny: false, firstShiny: false });
  if (!Number.isFinite(t)) return nothing(state);
  const day = dayKey(t);
  const today = state.day === day ? state.today : 0;
  let s = { ...state, digs: state.digs + 1, day, today };
  if (ctx.manual) {
    if (!canDig(state, t)) return nothing(state);
    s = { ...s, lastManualAt: t };
  } else {
    const first = total(state) === 0; // his very first dig always turns something up
    const lucky = first || s.dry + 1 >= DRY_SPELL || rand() < DIG_CHANCE * clampBoost(ctx.digBoost, 2);
    if (!first && (today >= DAILY_CAP || t - state.lastFindAt < FIND_GAP || !lucky)) return nothing({ ...s, dry: s.dry + 1 });
  }
  const find = pickFind(s, ctx, rand);
  if (!find) return nothing(s);
  const isNew = !s.items[find.id];
  const shiny = rand() < SPARKLE_CHANCE * clampBoost(ctx.shinyBoost, MAX_SPARKLE_BOOST);
  let next = add(s, find, t, shiny);
  if (!ctx.manual) next = { ...next, today: next.today + 1 };
  return { state: next, find, isNew, completed: newlyCompleted(s, next), shiny, firstShiny: shiny && !s.items[find.id]?.shiny };
}

const clampBoost = (v, max) => Math.max(1, Math.min(max, Number(v) || 1));

/** A find in its sparkly colours (the Bugdex's shiny turn, bugdex/art.js). */
const sparkly = find => (find ? art.shiny({ pixels: find.pixels, palette: find.palette }) : null);

/** How many sparkly finds there are on the shelf, all kinds together. */
const sparkles = stateIn => Object.values(normalize(stateIn).items).reduce((n, it) => n + (it.shiny || 0), 0);

/**
 * A keepsake for a special day ('birthday' | 'hatchday'), once per year.
 * Returns the same shape as dig(), or a null find when it's already been given.
 */
function keepsake(stateIn, special, now) {
  const state = normalize(stateIn);
  const t = Number(now);
  const tag = `${special}:${new Date(t).getFullYear()}`;
  const find = FINDS.find(f => f.special === special);
  if (!find || !Number.isFinite(t) || state.specials.includes(tag)) return { state, find: null, isNew: false, completed: [] };
  const isNew = !state.items[find.id];
  const next = { ...add(state, find, t), specials: [...state.specials, tag].slice(-20) };
  return { state: next, find, isNew, completed: [] };
}

/** Can "Dig for treasure" go now? */
const canDig = (state, now) => Number(now) - normalize(state).lastManualAt >= MANUAL_EVERY;
/** When it can next go (ms epoch). */
const nextDigAt = state => normalize(state).lastManualAt + MANUAL_EVERY;

const setDone = (state, set) => set.members.every(id => state.items[id]);
function newlyCompleted(before, after) {
  return SETS.filter(set => !setDone(before, set) && setDone(after, set)).map(s => s.id);
}

/** The find he'd show off: the one you picked, else the rarest you have (newest first on a tie). */
const RANK = { legendary: 4, special: 3, rare: 2, uncommon: 1, common: 0 };
function favourite(stateIn) {
  const state = normalize(stateIn);
  if (state.favourite) return findById(state.favourite);
  const owned = Object.entries(state.items).map(([id, it]) => ({ f: findById(id), last: it.last }));
  owned.sort((a, b) => RANK[b.f.rarity] - RANK[a.f.rarity] || b.last - a.last);
  return owned[0]?.f || null;
}

/** His line when he hands it over: the name if it fits, flavoured by rarity. */
function foundLine(find, rand = Math.random) {
  if (!find) return null;
  const short = find.name.toLowerCase();
  const a = /^[aeiou]/.test(short) ? 'an' : 'a';
  const pick = xs => xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))];
  const options = {
    common: [`${a} ${short}!`, 'found something!', 'for you!'],
    uncommon: [`ooh, ${short}!`, 'look what I found', 'for you!'],
    rare: [`${a} ${short}!!`, 'ooh, a rare one!', 'look look look!'],
    legendary: ['TREASURE!!', `${short}!!`, 'we\'re rich!'],
    special: ['for you, today', 'a special one', 'just for today'],
  }[find.rarity];
  const fits = options.filter(l => l.length <= 24);
  return pick(fits.length ? fits : ['for you!']);
}

/** Everything the shelf shows. Finds you haven't got are there as silhouettes. */
function view(stateIn, now = Date.now(), { seasons = [], event = null, back = {} } = {}) {
  const state = normalize(stateIn);
  const fav = favourite(state);
  return {
    total: total(state),
    sparkles: sparkles(state),
    kinds: kinds(state),
    of: FINDS.length,
    digs: state.digs,
    favourite: fav?.id || null,
    nextDigAt: nextDigAt(state),
    canDig: canDig(state, now),
    unseen: state.unseen,
    finds: FINDS.map(f => {
      const it = state.items[f.id];
      return {
        id: f.id, rarity: f.rarity, rarityLabel: RARITY[f.rarity].label, set: f.set,
        season: f.season, inSeason: (!f.season || seasons.includes(f.season)) && (!f.event || f.event === event), night: f.night, special: f.special,
        event: f.event, back: f.event && Number.isFinite(back[f.event]) ? back[f.event] : 0,
        owned: !!it, count: it?.n || 0, first: it?.first || 0,
        shiny: it?.shiny || 0, shinyFirst: it?.shinyFirst || 0, held: it?.held || 0,
        ...(it?.shiny ? { shinyArt: sparkly(f) } : {}),
        // The name and the line are part of the surprise, except for keepsakes,
        // which say what day to look out for.
        name: it || f.special ? f.name : '???',
        blurb: it ? f.blurb : hintFor(f),
        pixels: f.pixels, palette: f.palette,
      };
    }),
    sets: SETS.map(set => ({ id: set.id, name: set.name, icon: set.icon, have: set.members.filter(id => state.items[id]).length, of: set.members.length, done: setDone(state, set), members: set.members })),
  };
}

// events.js requires nothing from here, but these names are its: kept in step by test/gifts.test.js.
const EVENT_NAMES = { harvest: 'Harvest Moon', haunting: 'The Haunting', frostbite: 'Frostbite', penpal: 'Pen Pal Week', 'spring-clean': 'Spring Clean', 'low-tide': 'Low Tide' };

function hintFor(f) {
  if (f.special === 'birthday') return 'Turns up on your birthday (set it on the Us page).';
  if (f.special === 'hatchday') return 'Turns up on the anniversary of the day he moved in.';
  if (f.season) return `Only turns up in ${{ halloween: 'Spooky Season', winter: 'the winter holidays', valentine: 'Valentine’s week', spring: 'spring', summer: 'summer', autumn: 'autumn' }[f.season]}.`;
  if (f.event) return `Only turns up during ${EVENT_NAMES[f.event] || 'a tide event'}.`;
  if (f.night) return 'Only turns up after dark.';
  if (f.rarity === 'legendary') return 'Legendary. Keep digging.';
  return 'Not found yet.';
}

// ------------------------------------------------------------------ swaps (swaps.js)
// A copy offered in a swap is set aside (held) until the swap is done or off.
// You always keep one of everything: a copy can go while another stays.

/** Can this copy go in a swap? */
function spare(stateIn, id, shiny = false) {
  const it = normalize(stateIn).items[id];
  if (!it) return false;
  const free = it.n - (it.held || 0);
  if (free < 2) return false; // one always stays on the shelf
  if (shiny) return (it.shiny || 0) - (it.heldShiny || 0) >= 1;
  return it.n - (it.shiny || 0) - ((it.held || 0) - (it.heldShiny || 0)) >= 1;
}

const bump = (state, id, f) => {
  const it = state.items[id];
  return it ? normalize({ ...state, items: { ...state.items, [id]: f(it) } }) : state;
};
/** Set a copy aside for a swap. */
const hold = (stateIn, id, shiny = false) => bump(normalize(stateIn), id, it => ({ ...it, held: (it.held || 0) + 1, heldShiny: (it.heldShiny || 0) + (shiny ? 1 : 0) }));
/** The swap's off: it's yours again. */
const release = (stateIn, id, shiny = false) => bump(normalize(stateIn), id, it => ({ ...it, held: Math.max(0, (it.held || 0) - 1), heldShiny: Math.max(0, (it.heldShiny || 0) - (shiny ? 1 : 0)) }));
/** The swap's done: the copy set aside goes to your friend. */
const handOver = (stateIn, id, shiny = false) => bump(normalize(stateIn), id, it => ({
  ...it, n: it.n - 1, held: Math.max(0, (it.held || 0) - 1),
  shiny: Math.max(0, (it.shiny || 0) - (shiny ? 1 : 0)), heldShiny: Math.max(0, (it.heldShiny || 0) - (shiny ? 1 : 0)),
}));
/**
 * A find from a friend: on the shelf like one he dug up, without counting as a
 * dig. Returns { state, isNew, completed }.
 */
function receive(stateIn, id, shiny, now) {
  const state = normalize(stateIn);
  const find = findById(id);
  if (!find || find.special || !Number.isFinite(Number(now))) return { state, isNew: false, completed: [] };
  const isNew = !state.items[id];
  const next = { ...add(state, find, Number(now), !!shiny), lastFindAt: state.lastFindAt, dry: state.dry, day: state.day, today: state.today };
  return { state: next, isNew, completed: newlyCompleted(state, next) };
}

/**
 * What you could swap away and what you're after, for your calling card.
 * offers: copies past your first (sparkly ones marked), rarest first.
 * wants: what's missing from the sets you're closest to finishing.
 */
function swapLists(stateIn, { max = 6 } = {}) {
  const state = normalize(stateIn);
  const offers = [];
  for (const f of [...FINDS].sort((a, b) => RANK[b.rarity] - RANK[a.rarity])) {
    if (f.special) continue;
    if (spare(state, f.id, true)) offers.push(`${f.id}*`);
    if (spare(state, f.id, false)) offers.push(f.id);
  }
  const sets = SETS.map(set => ({ set, have: set.members.filter(id => state.items[id]).length }))
    .filter(x => x.have > 0 && x.have < x.set.members.length)
    .sort((a, b) => (b.have / b.set.members.length) - (a.have / a.set.members.length));
  const wants = [];
  for (const { set } of sets) for (const id of set.members) if (!state.items[id] && !findById(id).special && !wants.includes(id)) wants.push(id);
  return { offers: offers.slice(0, max), wants: wants.slice(0, max) };
}

/** Would this find finish one of your sets? The set's name, or null. */
function finishes(stateIn, id) {
  const state = normalize(stateIn);
  if (state.items[id]) return null;
  const set = SETS.find(x => x.members.includes(id) && x.members.every(m => m === id || state.items[m]));
  return set ? set.name : null;
}

/** Pick the one he shows off (null goes back to the rarest). */
function setFavourite(stateIn, id) {
  const state = normalize(stateIn);
  if (id != null && !Object.hasOwn(state.items, id)) return state;
  return { ...state, favourite: id || null };
}

/** The shelf has been looked at. */
const markSeen = stateIn => ({ ...normalize(stateIn), unseen: [] });

module.exports = {
  FINDS, SETS, RARITY, DIG_CHANCE, DRY_SPELL, DAILY_CAP, FIND_GAP, MANUAL_EVERY, LEGENDARY_AFTER,
  SPARKLE_CHANCE, EVENT_NAMES,
  normalize, findById, eligible, pickFind, dig, keepsake, canDig, nextDigAt, favourite, foundLine, view, setFavourite, markSeen, total,
  sparkly, sparkles,
  spare, hold, release, handOver, receive, swapLists, finishes,
};
