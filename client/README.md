# ChatWave — Client

React single-page app (Vite, JavaScript) for the ChatWave real-time chat.
No UI libraries — plain CSS with variables (`src/styles/global.css`).

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and set `VITE_API_URL` / `VITE_SOCKET_URL`
   (also create `client/.env` when running `npm run dev` from the repo root).
3. `npm run dev`

## Scripts

- `npm run dev` — Vite dev server on http://localhost:5173
- `npm run build` — production build to `dist/`
- `npm run preview` — serve the production build locally
