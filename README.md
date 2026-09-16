# Arcana Duel

Arcana Duel is a React arena and deck builder for Magic: The Gathering cards. It combines an immutable rules engine, Scryfall's complete historical printing catalog, local solo play, and Supabase-ready authentication and realtime match persistence.

## Run locally

```bash
npm install
npm run dev
```

The Vite client runs at `http://localhost:4173` and the local Socket.IO table server runs at `http://localhost:4174`. The practice arena and deck builder do not require cloud credentials.

## Verification

```bash
npm test
npm run lint
npm run build
```

## Scryfall catalog

`src/services/scryfall.ts` provides rate-limited, retrying Scryfall requests, fuzzy/exact lookup, collection batching, React search/import hooks, IndexedDB persistence, resumable full-catalog ingestion, JSON export, and deterministic oracle parsing. The exhaustive importer requests every paper/digital printing, including extras, multilingual cards, and variations, and follows every `next_page` cursor.

Scryfall asks clients to identify themselves and average no more than ten requests per second. The shared request queue enforces a 100 ms minimum interval and honors `Retry-After` responses.

## Supabase

1. Create a Supabase project and enable anonymous sign-ins under Authentication.
2. Copy `.env.example` to `.env.local` and provide the project URL and anon key.
3. Apply every file in `supabase/migrations` in filename order with the Supabase dashboard SQL editor or CLI.
4. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the Vercel project.

The migrations create `user_profiles`, cross-device `stored_decks`, `live_matches`, and append-only `match_events`; install row-level security; add match/event tables to Supabase Realtime; and expose atomic lobby and match RPCs. Deck changes are written locally immediately, reconciled by stable client key, and debounced to Supabase when configured. `src/services/matchRealtime.ts` subscribes to database changes and broadcasts movement, tap, counter, life, stack, priority, and phase events.

## Rules engine

`src/engine` is a JSON-safe immutable state machine with the full turn sequence: untap, upkeep, draw, precombat main, beginning of combat, attackers, blockers, damage, end of combat, postcombat main, end, and cleanup. It enforces priority, consecutive passes, FILO resolution, timing, mana payment, land limits, targeting, combat restrictions, keyword combat behavior, state-based actions, and win/loss state.

The deterministic bot consumes the same legal-action surface and evaluates land development, mana abilities, casts, targets, attacks, blocks, phase progression, and priority passes.

## Deploy

The included `vercel.json` builds the Vite app and preserves client-side routes.

```bash
vercel deploy --prod
```

The development Socket.IO server is useful for local manual tables. Production realtime transport is Supabase because Vercel does not host persistent Socket.IO processes.
