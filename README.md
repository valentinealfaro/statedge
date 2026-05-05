# StatEdge AI

Sports stats comparison platform (NBA / MLB / NFL). Compare Player vs Team, Player vs Player, Team vs Team. NOT a betting platform.

Full spec: [`STATEDGE AI Instructions.txt`](./STATEDGE%20AI%20Instructions.txt)

## Layout

```
backend/    Express + TypeScript API
frontend/   React + Vite (added later)
```

## Run it

You need two terminals.

**Terminal 1 — backend:**
```bash
cd backend
npm install
npm run dev
```

**Terminal 2 — frontend:**
```bash
cd frontend
npm install
npm run dev
```

Then open http://localhost:5173 — search for `lebron`, `jokic`, etc.

Backend health: http://localhost:4000/health
Player search API: http://localhost:4000/api/search/players?query=lebron

## Database

Schema lives at [`backend/db/schema.sql`](./backend/db/schema.sql). Not yet wired into the running app — see "Next steps" in the spec. Recommended host: [Neon](https://neon.tech) free tier.

## Tests

```bash
cd backend
npm test
```

## Database (optional, for caching)

App runs without a DB by hitting NBA stats live. To enable caching:

1. Sign up at [neon.tech](https://neon.tech) → create a project → copy the connection string.
2. `cp backend/.env.example backend/.env` and paste it into `DATABASE_URL`.
3. `cd backend && npm run db:migrate` (applies schema).
4. `npm run db:sync-players` (pulls all NBA players into the players table).

## AI summaries

Set `OPENAI_API_KEY` in `backend/.env`. The "Generate AI summary" button on each comparison page will then call `gpt-4o-mini` with the comparison data.

## Status

Week 1–4 partially shipped:
- Player vs Team, Player vs Player, Team vs Team comparisons (live)
- Trend / consistency / delta math (tested)
- AI summary endpoint (gated on OPENAI_API_KEY)
- Landing page + pricing + router

Next blockers (need user action):
- Neon Postgres connection string (for DB caching + saved comparisons)
- Firebase Auth setup (for plan gating + saved comparisons)
- Stripe keys (for Pro/Elite billing)
- OpenAI key (to enable AI summaries)
