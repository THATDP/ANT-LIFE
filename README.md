# ANT LIFE

ANT LIFE is a private, cooperative 3D ant-colony survival game for the browser. Players explore the garden as ants, gather and carry resources, look after their own needs, and help a shared colony grow. The world and all actions that change it are controlled by the Node.js server; clients receive shared snapshots over WebSockets.

## Run locally

Requirements: Node.js 22 and npm.

```bash
npm ci
cp .env.example .env
npm run dev
```

Open <http://localhost:5173>. The development invite in `.env.example` is `ANT-LIFE-LOCAL`; change it for any environment other than your own machine. The development server uses `.local/colony.json` when `DATABASE_URL` is unset. That file is intentionally ignored by Git. For local PostgreSQL/Neon testing, set `DATABASE_URL` in your untracked `.env` file.

The Vite client runs on port 5173 and proxies `/api` and `/ws` to the game server on port 3001. To run them separately, use `npm run dev:client` and `npm run dev:server` in two terminals.

## Controls

| Input | Action |
| --- | --- |
| WASD | Move relative to the camera |
| Mouse | Look around while pointer lock is active; click the game to capture the pointer |
| Shift | Run (uses energy) |
| Space | Jump |
| E | Gather a nearby resource, enter/leave the nest, drink at the pond, or deposit while underground |
| Q | Bite a nearby predator |
| R / V | Eat / drink from carried dew |
| B | Open the nest construction menu |
| M | Open the shared map |
| Tab | Open inventory |
| C or 1 / 2 / 3 | Cycle cameras or select first-person, third-person, and colony/top view |
| Mouse wheel | Zoom the camera |
| Escape | Release pointer lock, close an overlay, or open settings |

A player can carry up to eight resource units. Gathered food, dew, soil, and leaves remain distinct when deposited. Construction is server-validated and requires being inside the nest, having the materials, and placing the new room within the connected colony.

## Game systems

- Deterministic procedural garden terrain, landmarks, resources, foliage, a pond, and an explorable underground nest.
- Three camera modes, quality settings, a minimap, inventory and colony panels, day/night lighting, weather, rain, and rising-water warnings.
- Server-authoritative movement, hunger, thirst, energy, collection, deposits, building, player recovery, predators, and shared discoveries.
- Autonomous ants with specialized roles, changing colony tasks, obstacle-aware routes, resource carrying, threat avoidance, pheromone trails, brood care, and defense. Ants far from players/threats use a slower movement/decision cadence than nearby agents.
- Colony population, queen health, brood lifecycle, storage, construction, weather, and bounded offline catch-up simulation.
- Invite-only joins, signed reconnect sessions, nickname validation, WebSocket origin checks, message-size and rate limits, and a 32-connection ceiling. The ceiling is a code guard, not a capacity or performance claim; the game has not been load-tested.

## Persistence and services

Set `DATABASE_URL` to use PostgreSQL (Neon is the intended hosted provider). On startup the server applies `server/migrations/001_initial.sql`; the current store keeps one authoritative JSONB world snapshot and indexed player/event records. The server snapshots on startup, on player join/disconnect, and every 20 seconds rather than writing each simulation frame. A bounded aggregate simulation (up to seven days per catch-up) advances the colony when the server starts after being offline.

If `DATABASE_URL` is absent in development, persistence falls back to an atomic local JSON snapshot. Production startup rejects missing `DATABASE_URL`, `INVITE_CODE`, `SESSION_SECRET` (at least 32 characters), or `ALLOWED_ORIGINS`. Do not commit `.env`, connection strings, invite codes, or session secrets.

## Verification

```bash
npm test
npm run typecheck
npm run build
```

The automated tests cover private invites and signed sessions, deterministic world generation, bounded offline simulation and per-resource colony stocks, pheromone decay, pathfinding, interrupted AI assignments, and a WebSocket integration flow for unauthorized access, simultaneous players, authoritative movement, gathering/deposit/build actions, reconnect, and save/reload. These checks do not replace a real-browser/WebGL or hosted-Neon deployment test.

## Render + Neon deployment preparation

`render.yaml` describes one **free-plan** Render web service. The production Node server serves `dist/client` and the WebSocket/API from the same origin, so the browser does not need a hard-coded backend URL. A Neon project is still required for durable hosted saves.

1. Create a Neon PostgreSQL project on its free tier and copy its connection string. Keep billing/plan settings under your control; this repository does not provision or upgrade paid services.
2. Import this repository into Render using the Blueprint in `render.yaml`. The Render service is configured for `plan: free` and `autoDeploy: false`.
3. Supply `DATABASE_URL` and a private `INVITE_CODE` (at least six characters) when Render prompts for them. Render generates `SESSION_SECRET`; keep it private. `ALLOWED_ORIGINS` defaults to `https://ant-life.onrender.com`; update it to the exact origin Render assigns if that hostname differs.
4. Deploy, then verify `/health`, the login screen, WebSocket join/reconnect, and a save/restart against Neon. Share the invite code only with intended players.

No production deployment or hosted database has been provisioned or verified from this repository checkout. The deployment link is therefore not yet available. Free-tier services may sleep or have quotas; check provider limits before use. The Render filesystem is ephemeral, so hosted production must use Neon rather than local-file persistence.
