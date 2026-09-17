# Arcana Duel — Audit Roadmap

Working plan from the full mechanics + visual audit (Sept 2026). Sectioned into
phases so each one is a self-contained chunk: pick a phase, grind through its
items, verify (build+test+lint), commit, push, check it off. Order below is my
recommended priority, not a hard requirement — reorder anytime.

Legend: 🟢 small · 🟡 medium · 🔴 large

## Phase 1 — Correctness quick fixes (practice mode)
Cheap, contained, high-confidence fixes. Do these first.

- [x] 🟢 Rockfall Vale only ever produces {R}, never {G} — mana-production regex
      in `arenaAdapter.ts` doesn't catch "Add {R} or {G}" alternation.
- [x] 🟡 Reclamation Sage can get stuck in an uncastable "choose a target" dead
      end when no artifact/enchantment exists — optional ETB treated as a hard
      cast requirement. Also fix the bot's separate, narrower "needs target"
      check so it can actually cast this card.
- [x] 🟡 Blocker-selection UI doesn't check flying/reach/menace before
      highlighting a defender as clickable — only the final submit is
      validated, so illegal block sets bounce with one confusing error and no
      indication which assignment was bad.
- [x] 🟡 Attacker doesn't get to choose damage-assignment order when
      double-blocked (currently follows defender's declared block order).
- [x] 🟢 No max hand size / discard-to-7 step in cleanup.
- [x] 🟢 No legend rule (bites specifically with Questing Beast x2 / Embercleave
      x2, both in the 14-card catalog).
- [ ] 🟢 Questing Beast catalog text is missing 3 of its 4 real abilities
      (can't-be-blocked-by-power-2-or-less, damage-can't-be-prevented, attack
      trigger) — at minimum fix the "can't be blocked by power ≤2" part since
      that's the one that actually matters without planeswalkers.

## Phase 2 — Bot AI quality
Contained to `bot.ts`; makes solo play meaningfully less exploitable.

- [x] 🟡 Blocking never checks total unblocked damage against its own life —
      bot can decline profitable-looking blocks and just die.
- [x] 🟡 Bot proactively casts instants/removal instead of holding them up
      during the opponent's combat.
- [x] 🟡 Land/spell sequencing is alphabetical, not color/curve-aware.

## Phase 3 — Visual quick wins
Cheap, high-visibility, don't require touching the engine.

- [ ] 🟡 Lobby renders in the wrong font — three overlapping CSS passes from
      different points in the project's history are stacked in styles.css;
      the last one silently wins and swaps Cinzel for Inter on the Lobby only.
      Needs deleting the superseded pass(es), not just patching values.
- [ ] 🟡 Mana pip icons (Lucide flame/leaf outline icons at 9-11px) read as
      fuzzy squiggles at actual render size — every single card shows one.
- [ ] 🟡 Below ~820px width the mana-availability readout is just hidden with
      nothing replacing it; below 1120px the card inspector disappears with
      no fallback (double-click zoom still works but isn't taught).
- [ ] 🟡 Land piles fan out individually instead of collapsing into one
      stacked pile with a count badge — sprawls badly with 5+ of a kind.
- [ ] 🟢 Mana-cost badge shown redundantly on permanents already in play
      (lands included) — should be suppressed once a card is on the
      battlefield.

## Phase 4 — Engine structural gaps (large lifts, do deliberately)

- [ ] 🔴 No equip/attach/aura subsystem at all — Embercleave currently does
      nothing when cast (no +1/+1, no double strike/trample on the actual
      creature, no cost-reduction rider). Needs: attach relation on
      CardInstance, equip-cost activated ability, ETB attach trigger, layer
      application in getPower/getToughness/hasKeyword, detach-on-death.
- [ ] 🔴 Oracle-text→engine pipeline only wires up damage-on-cast and
      enters-the-battlefield effects. Dies/attacks/upkeep/end-step triggers
      and discard/mill/scry/tutor/sacrifice-cost effects are parsed and then
      silently dropped — most imported real cards will be mechanically inert.
      This is the biggest single lift; probably worth tackling one trigger
      bucket / effect kind at a time rather than all at once.
- [ ] 🔴 `refreshContinuousEffects` is one hardcoded regex for a single
      Kird-Ape-shaped pattern, not a general static-ability/layers system —
      any other "as long as you control a ___" or anthem-style card is a dead
      letter.
- [ ] 🟡 No sacrifice/discard/pay-life costs for activated abilities — only
      mana + tap.
- [ ] 🟡 Target-restriction pipeline has no "target creature an opponent
      controls" kind — only plain "target creature" and "creature you
      control" exist. No live exploit today (no catalog card uses the
      phrasing) but blocks any future removal spell from being safe.
- [ ] known-but-deferred: hexproof/ward/protection parsed but not enforced in
      targeting.

## Phase 5 — Online multiplayer
Only worth prioritizing once we've confirmed online is actually a mode you
want to keep pushing on (env vars / anon auth still unconfirmed as working
live).

- [ ] 🔴 Online matches have no real combat — the server RPC just cycles
      phase labels, no attacker/blocker declaration or damage math exists.
      This needs the practice engine's combat logic ported server-side (or
      moved into a shared ruleset called from an edge function).
- [ ] 🟢 `life` action has no rate limit / priority check — can be spammed for
      unlimited life gain.
- [ ] 🔴 OnlineMatch.tsx is a parallel, visually-divergent reimplementation of
      the board (different avatar, life display, card component, stack
      panel) — doesn't share components with PracticeMatch, so fixes to one
      don't propagate to the other.
- [ ] 🟡 No graveyard/exile viewer online (practice mode has one).
- [ ] 🟢 No turn timer / stall protection.
- [ ] 🟢 No explicit "Concede" button distinct from "Leave match" (leaving
      does correctly forfeit already, just unlabeled as a concession).
- [ ] 🟢 `spectators` field on CloudRoom is a stub, always 0, never wired up.

## Phase 6 — Content/data correctness
Lower urgency, groups the remaining catalog/oracle-parser nitpicks.

- [ ] 🟢 Kessig Naturalist's catalog ability text is fabricated (doesn't match
      the real card at all) — low priority since it's cosmetic at this point.
- [ ] 🟢 Clean up the mulligan/hand double-pass CSS drift pattern more broadly
      if more of it turns up while working other phases (border-radius,
      duplicated `.lobby-page`/`.match-option`/`.player-badge` rules).

---
Known-good, verified correct — don't re-audit these:
flying/reach, trample, first strike/double strike, deathtouch, lifelink
(applies on every damage path, not just combat), vigilance (engine state,
not just CSS), haste, defender, menace, indestructible, flash, summoning
sickness, mana pool draining between phases/steps, auto-tap backtracking
search, multi-blocker damage summed correctly against the attacker,
first-strike-kills-blocker-before-regular-damage, illegal-target fizzle
handling, simultaneous double-loss → draw, 0-toughness-from-non-damage dies
correctly, London mulligan, deck legality (size/copies/bans), Moxfield/
Archidekt import, matchmaking queue.
