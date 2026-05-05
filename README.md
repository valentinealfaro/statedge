# StatEdge AI

Sports stats comparison platform (NBA / MLB / NFL). Compare Player vs Team, Player vs Player, Team vs Team. NOT a betting platform.

Full spec: [`STATEDGE AI Instructions.txt`](./STATEDGE%20AI%20Instructions.txt)

## Layout

```
backend/    Express + TypeScript API
frontend/   React + Vite (added later)
```

## Run the backend

```bash
cd backend
npm install
npm run dev
```

Then open http://localhost:4000/health — you should see `{"status":"ok"}`.

## Status

Week 1 of 4 — scaffolding. Database, auth, NBA sync, and frontend come next.
