import http from 'node:http';
import mongoose from 'mongoose';
import app from './app.js';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';
import { attachSockets } from './sockets/index.js';
// Importing the models barrel registers all models so Mongoose builds their
// indexes on boot and schema problems surface immediately.
import './models/index.js';

const server = http.createServer(app);
// Realtime layer: JWT-authenticated sockets, presence, rooms and events.
const io = attachSockets(server);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received - shutting down gracefully`);

  const forceExit = setTimeout(() => {
    console.error('[server] Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  io.close(); // disconnect all sockets before draining the HTTP server
  server.close(() => {
    mongoose.connection
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function start() {
  try {
    await connectDB();

    server.listen(env.PORT, () => {
      console.log(`[server] ChatWave API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
      console.log(`[server] Socket.io attached — CORS allowed origin: ${env.CLIENT_URL}`);
    });
  } catch (err) {
    console.error(`[server] Failed to start: ${err.message}`);
    process.exit(1);
  }
}

start();
