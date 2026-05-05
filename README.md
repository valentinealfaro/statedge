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

## Status

Week 1 of 4. Done: backend scaffold, NBA player search via stats.nba.com, frontend search UI.
Next: connect Neon Postgres, sync players/teams/games into DB, then build the comparison page.
