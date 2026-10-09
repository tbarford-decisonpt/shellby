'use strict';

// What a catch pays out: stats, XP, the card, the jar and the toast. Made by
// wireBugdex (wiring/bugdex.js).

const focus = require('../focus');
const recap = require('../recap');
const bugdex = require('../bugdex');
const lifecycle = require('../bugdex/lifecycle');
const { HABITATS, live, speciesById } = require('../bugdex/species');
const events = require('../events');

const LIVE = new Set([...live().map(s => s.id), 'missingno']);

/**
 *   d: what main shares; names: wireBugdex's project id -> name map (shared, by reference);
 *   view, openPage: thunks, as they're declared after this is made.
 */
function makeReward({ d, view, names, openPage }) {
  function reward(e, r, { quiet, boosts = null }) {
    const sp = speciesById(e.species);
    const projectName = e.name || names.get(e.project) || null;
    // What the tide events' goals look at (events.js): where it lived, and whether it was the event's own.
    d.stat('bug-caught', { habitat: sp.habitat, species: sp.id });
    if (sp.event) d.stat('event-bug', { event: sp.event, species: sp.id });
    const shiny = r.forms.includes('shiny');
    if (shiny) {
      d.stat('sparkle-found');
      if (sp.rarity === 'legendary') d.stat('sparkle-legendary');
      d.awardXp('sparkle', { project: projectName, label: `A sparkly ${sp.name}` });
      d.life?.remember?.('first-shiny', { item: sp.name });
    }
    if (sp.rarity === 'legendary') d.stat('legendary-bug');
    if (r.forms.includes('golden')) d.stat('golden-catch');
    const book = r.state.species;
    const caughtIds = Object.keys(book).filter(id => bugdex.caughtOf(book[id]) > 0);
    d.stat('bug-species', { n: caughtIds.filter(id => LIVE.has(id) && id !== 'missingno').length });
    d.stat('ghost-species', { n: caughtIds.filter(id => speciesById(id)?.habitat === 'wreck').length });
    d.noteWeek('caught');
    if (r.isNew) d.noteWeek('newbug');
    d.noteRecap?.(recap.bugEvent(e.species, r.isNew)); // "3 bugs caught" in the while-you-were-away card
    // A catch that came along quietly with another still pays: only the moment is shared.
    if (r.pays) {
      const label = r.isNew ? `Caught a ${sp.name} (${sp.rarity === 'special' ? 'mystery' : sp.rarity})` : `Caught a ${sp.name}`;
      // Harvest Moon pays half again on a catch (events.js boosts).
      const boost = boosts && boosts.xp > 1 ? { by: boosts.xp, label: events.eventById(boosts.event)?.name } : undefined;
      d.awardXp(r.isNew ? 'newbug' : 'catch', { project: projectName, label, boost });
    }
    const habitats = r.completed.map(id => HABITATS.find(h => h.id === id)).filter(Boolean);
    for (const h of habitats) {
      d.stat('habitat-done');
      d.awardXp('treasure', { label: `Finished ${h.name} in the Bugdex` });
    }
    if (quiet) return;
    const v = view().species.find(x => x.id === e.species);
    const card = {
      id: sp.id, name: v?.name || sp.name, rarity: sp.rarity, isNew: r.isNew, forms: r.forms, evolved: r.evolved, stage: r.stage, completed: habitats.map(h => h.name), pixels: v?.pixels || sp.pixels, palette: v?.palette || sp.palette,
      badge: r.badge ? HABITATS.find(h => h.id === r.badge).badge.name : null, league: r.league, fame: r.fame,
      battle: e.source ? lifecycle.encId(e) : null, // the battle screen plays the catch out itself
    };
    d.send(d.panel, 'bugdex:caught', card);
    if (shiny) {
      const odds = Math.round(1 / (bugdex.SHINY_CHANCE * Math.max(1, boosts ? boosts.shinyFor(sp.habitat) : 1)));
      d.send(d.panel, 'sparkle:reveal', {
        kind: 'bug', id: sp.id, name: card.name, rarity: sp.rarity, pixels: card.pixels, palette: card.palette,
        odds, after: bugdex.summary(r.state).jars - 1, at: Date.now(), level: d.currentLevel?.() || 1, project: projectName,
      });
      d.send(d.critter, 'critter:sound', { cue: 'sparkle' });
    }
    if (r.moment) {
      const jar = bugdex.jarFor(sp.id, r.forms);
      const hushed = focus.guarding(d.config.get('focus'), Date.now());
      d.life?.presentJar({
        species: sp.id, ...jar, ghost: sp.habitat === 'wreck',
        cry: { no: sp.no, type: sp.type, rarity: sp.rarity }, // its own little call as it goes in (critter/sound.js)
        line: hushed ? null : bugdex.catchLine(sp.id, { isNew: r.isNew, forms: r.forms, evolved: r.evolved }),
      });
      if (sp.rarity === 'legendary' || r.forms.includes('golden') || r.forms.includes('shiny') || r.badge || r.fame) d.send(d.critter, 'critter:burst', d.outfit().confetti);
    }
    if (r.badge || r.fame) d.send(d.critter, 'critter:sound', { cue: 'badge' });
    const badge = r.badge ? HABITATS.find(h => h.id === r.badge)?.badge : null;
    const big = r.isNew || r.evolved || habitats.length || sp.rarity === 'legendary' || shiny || !!sp.event;
    if (big && !(d.panel?.isVisible() && d.panel.isFocused())) {
      const where = projectName ? ` Caught in ${projectName}.` : '';
      const title = r.fame ? 'Bugdex: you made the Hall of Fame!'
        : badge ? `You earned the ${badge.name}!`
          : r.league === 'champion' ? `You beat the Champion, ${sp.name}!`
            : r.league === 'elite' ? `One of the Deep Four beaten: ${sp.name}!`
              : habitats.length ? `Bugdex: ${habitats[0].name} is complete!`
        : shiny ? `✨ A sparkly ${sp.name}!`
        : sp.event ? `${events.eventById(sp.event)?.emoji || ''} ${sp.name} came along!`.trim()
        : r.evolved ? `Your ${sp.name} evolved!`
          : sp.rarity === 'legendary' ? `A legendary bug: ${sp.name}!` : `New to the Bugdex: ${sp.name}`;
      const body = r.fame ? `Every badge, the Deep Four and the champion. ${sp.name} was the last.`
        : badge ? `You beat ${sp.name}, the boss of ${HABITATS.find(h => h.id === r.badge).name}.${where}`
          : shiny ? `1 in ${Math.round(1 / bugdex.SHINY_CHANCE)}, and it's in a jar.${where}`
            : r.evolved ? `It's a ${card.name} now.${where}` : `${sp.blurb}${where}`;
      d.notify(title, body, () => openPage(sp.id), { tone: 'celebrate', pet: true });
    }
  }

  return reward;
}

module.exports = { makeReward, LIVE };
