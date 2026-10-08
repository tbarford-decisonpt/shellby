// When a friend's crab visits, the two of them talk. What they say depends on
// both temperaments (a cocky crab meeting a fussy one is a different visit from
// two sleepy ones) and on what they have to talk about: who has more stickers,
// who's grown, a find worth showing off, the music that's on.
//
// A conversation is a few lines, alternating: { who: 'me' | 'them', text }.
// 'me' is your Shellby, 'them' the visitor. Pure (callers pass `rand`);
// src/main/main.js plays them. See test/banter.test.js.

const MAX_LINE = 24;
const T = ['chipper', 'fussy', 'cocky', 'sleepy'];
const temperament = v => (T.includes(v) ? v : 'chipper');

// ---- hello: by pair, "<mine>:<theirs>", each a list of two-line exchanges
const HELLO = Object.freeze({
  'chipper:chipper': [['you came!', 'of course!'], ['best day ever', 'EVER']],
  'chipper:fussy': [['hiii!', '…hello. wipe feet?']],
  'chipper:cocky': [['you made it!', 'obviously']],
  'chipper:sleepy': [['hello hello!', '…hi. so loud.']],
  'fussy:chipper': [['mind the sand', 'sand is fun!']],
  'fussy:fussy': [['shoes off?', 'already off.']],
  'fussy:cocky': [["you're late", 'fashionably']],
  'fussy:sleepy': [["you're yawning", "it's catching"]],
  'cocky:chipper': [['you missed me', 'SO much!']],
  'cocky:fussy': [['nice shell', "it's vintage"], ['bit dusty?', "it's patina"]],
  'cocky:cocky': [['nice shell', 'nicer than yours'], ['look who it is', 'the best crab']],
  'cocky:sleepy': [['wake up, champ', '…five more'], ['you came!', 'barely']],
  'sleepy:chipper': [['…oh. hi.', 'HI!!']],
  'sleepy:fussy': [['nap here?', 'not in public'], ['…hi', 'sit up straight']],
  'sleepy:cocky': [['…hey', "wake up, I'm here"]],
  'sleepy:sleepy': [['…hi', '…hi'], ['nap?', 'nap.']],
});
const FIRST_HELLO = Object.freeze([['welcome!', 'nice desk!'], ['first visit!', 'cosy in here']]);

// ---- goodbye: what each of them says on the way out
const BYE_ME = Object.freeze({ chipper: ['come back soon!', 'bye bye!'], fussy: ['close the door', 'safe travels'], cocky: ["you'll miss me", 'later!'], sleepy: ['…bye', 'bye… zz'] });
const BYE_THEM = Object.freeze({ chipper: ['see you soon!', 'byeee!'], fussy: ['thanks for having me', 'lovely visit'], cocky: ['you\'re welcome', 'until next time'], sleepy: ['…gotta nap', 'bye… yawn'] });

// ---- small talk: topics that need something to talk about, then the fallbacks
function topics(ctx, me, them) {
  const out = [];
  const mine = ctx.myStickers || 0, theirs = ctx.theirStickers || 0;
  if (theirs >= mine + 3) out.push([['me', 'so many stickers!'], ['them', 'I ship a lot'], ['me', 'show-off']]);
  if (mine >= theirs + 3) out.push([['them', 'look at your shell!'], ['me', 'I ship a lot'], ['them', 'teach me']]);
  const ml = ctx.myLevel || 1, tl = ctx.theirLevel || 1;
  if (tl >= ml + 3) out.push([['me', "you've grown!"], ['them', 'molted twice']]);
  if (ml >= tl + 3) out.push([['them', "you're huge now"], ['me', 'been busy']]);
  if (ctx.myFind) out.push([['me', 'look what I found'], ['them', fit(`ooh, ${ctx.myFind.toLowerCase()}!`, 'ooh, shiny!')], ['me', 'mine though']]);
  if (ctx.theirFind) out.push([['them', 'I found something'], ['me', fit(`a ${ctx.theirFind.toLowerCase()}?!`, 'no way!')], ['them', 'not sharing']]);
  if (ctx.music) out.push([['me', 'hear that?'], ['them', '♪ what a tune ♪'], ['me', 'dance?']]);
  const h = Number.isFinite(ctx.hour) ? ctx.hour : 12;
  if (h >= 22 || h < 5) out.push([['them', 'past your bedtime?'], ['me', "crabs don't sleep"], ['them', 'liar']]);
  const seasons = ctx.seasons || [];
  if (seasons.includes('halloween')) out.push([['me', 'nice costume'], ['them', "I'm a crab"], ['me', 'spooky']]);
  if (seasons.includes('winter')) out.push([['them', 'brr, cold out'], ['me', 'sit by the GPU'], ['them', 'toasty']]);
  // Pair jokes.
  if (me === 'cocky' && them === 'cocky') out.push([['me', 'claw wrestle?'], ['them', "you're on"], ['me', '…call it a tie']]);
  if (me === 'fussy' && them === 'chipper') out.push([['them', 'can I dig here?'], ['me', 'absolutely not'], ['them', 'aww']]);
  if (me === 'chipper' && them === 'sleepy') out.push([['me', 'wanna play?'], ['them', 'wanna nap?'], ['me', 'nap-play!']]);
  if (me === 'sleepy' && them === 'cocky') out.push([['them', 'race you'], ['me', 'you win'], ['them', 'obviously']]);
  if (me === 'fussy' && them === 'fussy') out.push([['me', 'tea?'], ['them', 'two sugars'], ['me', 'civilised']]);
  return out;
}
const FALLBACK = Object.freeze([
  [['me', "how's your human?"], ['them', 'busy. yours?'], ['me', 'same']],
  [['them', 'nice wallpaper'], ['me', 'I dig it'], ['them', 'literally']],
  [['me', 'seen any good shells?'], ['them', 'a teacup, once'], ['me', 'classy']],
  [['them', 'what do you do all day?'], ['me', 'supervise'], ['them', 'same']],
]);

const fit = (line, fallback) => (line.length <= MAX_LINE ? line : fallback);
const pick = (xs, rand) => xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))];
const asLines = pairs => pairs.map(([who, text]) => ({ who, text }));

/**
 * What the two of them say. phase: 'hello' | 'chat' | 'bye'.
 *   who: { me, them } temperaments
 *   ctx: { firstVisit, myStickers, theirStickers, myLevel, theirLevel, myFind,
 *          theirFind, music, hour, seasons }
 *   used: chat topics already had this visit (by first line), so they don't repeat
 */
function conversation(phase, { me: meIn, them: themIn } = {}, ctx = {}, rand = Math.random, used = []) {
  const me = temperament(meIn), them = temperament(themIn);
  let lines;
  if (phase === 'hello') {
    const [a, b] = pick(ctx.firstVisit ? FIRST_HELLO : HELLO[`${me}:${them}`] || [['hey!', 'hi hi!']], rand);
    lines = [{ who: 'me', text: a }, { who: 'them', text: b }];
  } else if (phase === 'bye') {
    lines = [{ who: 'them', text: pick(BYE_THEM[them], rand) }, { who: 'me', text: pick(BYE_ME[me], rand) }];
  } else {
    const fresh = [...topics(ctx, me, them), ...FALLBACK].filter(t => !used.includes(t[0][1]));
    if (!fresh.length) return [];
    // Topics with something real to say come first, then the small talk.
    const real = fresh.filter(t => !FALLBACK.includes(t));
    lines = asLines(pick(real.length && rand() < 0.75 ? real : fresh, rand));
  }
  return lines.filter(l => typeof l.text === 'string' && l.text.length <= MAX_LINE);
}

/** How long each line stays up, ms (longer lines get a little longer). */
const lineMs = text => 2200 + Math.min(1800, String(text || '').length * 60);

module.exports = { conversation, lineMs, HELLO, FALLBACK, TEMPERAMENTS: T, MAX_LINE };
