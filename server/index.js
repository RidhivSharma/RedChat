// ============================================================================
// Vercel entry point (serverless deployment).
//
// Vercel deploys this package as ONE Function ("Backends on Vercel", Express
// is detected from package.json and this file is the chosen entry). Every
// incoming request is served through the HTTP server exported below:
//
//   - /api/*       → the Express app (server/src/app.js)
//   - /socket.io/* → Socket.io, upgraded to a WebSocket by the platform
//                    (WebSockets are a public beta feature of Vercel Functions
//                    on Fluid compute; the client forces the websocket-only
//                    transport because long-polling cannot work there)
//
// Differences from src/server.js, the long-lived entry used locally and on
// classic hosts (Render, Railway, a VPS):
//   - no server.listen(): the platform owns the listener
//   - no presence heartbeat interval: instances are short-lived by design
//   - no SIGINT/SIGTERM shutdown: the platform stops instances itself
//
// Which file Vercel picks is pinned twice, on purpose:
//   1. package.json "main" (the current entrypoint resolver honours it), and
//   2. the zero-config Express detection, which scans entrypoint candidates
//      for an `import ... from 'express'` statement and takes the first match
//      in its own order (app, index, server, src/app, src/index, src/server) —
//      `index.js` here ranks before `src/app.js`.
// This matters: src/app.js exports the bare Express app WITHOUT Socket.io, so
// letting Vercel pick it would silently disable all realtime features.
// ============================================================================

// Detection marker (see above) — Express is a dependency of this package and
// is loaded by src/app.js anyway; this side-effect import exists so Vercel's
// entrypoint scan recognises index.js as the Express entry.
import 'express';

import { createServer } from 'node:http';
import app from './src/app.js';
import { connectDB } from './src/config/db.js';
import { attachSockets } from './src/sockets/index.js';
import './src/models/index.js';

// Cold start: Vercel keeps a Fluid instance warm across requests, so the
// connection pool is created once per instance here. If the connection fails
// the module load fails with it — the invocation errors out cleanly and the
// next request cold-starts and retries, instead of every later request
// failing against a half-initialised instance.
await connectDB();

const server = createServer(app);
attachSockets(server);

export default server;
