# oGeaked

Cyberpunk face-rating app with solo and multiplayer score battles.

## Features

- Solo mode with webcam face landmarks and live 0-10 Rizz Score updates every 500ms
- Face detection via `face-api.js` (`tinyFaceDetector` + `faceLandmark68Net`)
- Model loading from local `/public/models` for self-hosted use
- Multiplayer score-only mode over Socket.io (no video streaming, no persistence)
- Secure defaults: Helmet, score validation, score rate limiting, room UUIDs, socket cap
- Share score snapshots with `html2canvas`

## Project structure

```
/
├── client/
│   ├── public/models/
│   └── src/
├── server/
│   └── index.js
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## Local setup

1. Install dependencies:
   - `cd client && npm install` (also downloads models via `postinstall`; or run `npm run fetch-models` anytime)
   - `cd ../server && npm install`
2. Model files are written to `client/public/models/` by `scripts/fetch-models.mjs`:
   - `tiny_face_detector_model-weights_manifest.json`
   - `tiny_face_detector_model-shard1`
   - `face_landmark_68_model-weights_manifest.json`
   - `face_landmark_68_model-shard1`
3. Start backend:
   - `cd server && npm run dev`
4. Start frontend:
   - `cd client && npm run dev`
5. Open `http://localhost:5173`

## Environment variables (server)

- `PORT` (default `3000`)
- `NODE_ENV` (`development` or `production`)
- `CLIENT_ORIGIN` (required in production CORS lock)
- `MAX_CONNECTIONS` (default `500`)
- `RANKED_MATCH_MS` (default `45000`) — rated duel length; highest **peak** Geek Score wins

## Ranked multiplayer protocol (Socket.io)

- On connect, server sends `ranked:welcome` with starting `{ mmr, tier }` (ephemeral; no DB).
- Client queues with `ranked:queue`; server replies with `ranked:queue-update` (position + hint).
- Server pairs players with **skill-band matchmaking** (tighter MMR band at first, widens after ~15–30s in queue).
- When paired: `ranked:match-found` includes `{ roomId, endsAt, yourMmr, yourTier, opponentMmr, opponentTier }`.
- Each client emits `score:update` `{ score }` about every 500ms while dueling.
- Server validates scores (`number`, `0–10`) and rate-limits to **max 4 updates/sec per socket**.
- Live updates: `ranked:scores` → `{ yourScore, theirScore, yourPeak, theirPeak }`.
- Match ends when the timer hits `endsAt`: `ranked:result` with outcome, peak summary, and **Elo-style MMR** delta.
- `ranked:cancel-queue` leaves the queue; `ranked:forfeit` ends an active duel as a loss; disconnect/forfeit awards the remaining player.

## Security notes

- HTTP headers hardened with Helmet
- CORS open in development, locked to `CLIENT_ORIGIN` in production
- Socket transport is websocket-only (`polling` fallback disabled)
- Connection cap enforced in Socket.io middleware
- No user accounts or persistent user data

## Docker

Build and run:

```bash
docker compose up --build
```

App will be available at `http://localhost:3000`.

## Deploy

### Railway

1. Create a new project from repo.
2. Set root to repository root.
3. Railway auto-detects `Dockerfile`.
4. Set env vars:
   - `NODE_ENV=production`
   - `CLIENT_ORIGIN=https://your-domain`
   - `MAX_CONNECTIONS=500`

### Render

1. New Web Service from repo.
2. Environment: Docker.
3. Port: `3000`.
4. Set same env vars as above.

### VPS (Docker)

1. Install Docker + Compose.
2. Clone repo on server.
3. Run `docker compose up -d --build`.
4. Put Nginx/Caddy in front and proxy to `localhost:3000`.
5. Set `CLIENT_ORIGIN` to your HTTPS domain.

## Notes

- Multiplayer intentionally shares only scores, never camera data.
- Room state is ephemeral and cleaned on disconnect/next.
