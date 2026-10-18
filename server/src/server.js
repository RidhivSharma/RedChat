import http from 'node:http';
import mongoose from 'mongoose';
import app from './app.js';
import { env, clientOrigins } from './config/env.js';
import { connectDB } from './config/db.js';
import { attachSockets } from './sockets/index.js';
import {
  flushPresence,
  startPresenceHeartbeat,
  stopPresenceHeartbeat,
} from './sockets/presence.js';
import { logger } from './utils/logger.js';
// Importing the models barrel registers all models so Mongoose builds their
// indexes on boot and schema problems surface immediately.
import './models/index.js';

const server = http.createServer(app);
// Realtime layer: JWT-authenticated sockets, presence, rooms and events.
const io = attachSockets(server);

let shuttingDown = false;

function closeDatabase() {
  if (mongoose.connection.readyState === 0) return Promise.resolve();
  return mongoose.connection.close().catch((err) => {
    logger.error('failed to close the MongoDB connection', { error: err });
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal} - shutting down gracefully`);

  // Last resort: never hang forever on a stuck connection.
  const forceExit = setTimeout(() => {
    logger.error('shutdown did not finish in time - forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  stopPresenceHeartbeat();

  // Persist lastSeen for everyone still connected before sockets go away
  // (disconnect handlers also write it; this is the safety net).
  try {
    const flushed = await flushPresence();
    if (flushed > 0) logger.info(`presence flushed for ${flushed} user(s)`);
  } catch (err) {
    logger.error('presence flush failed during shutdown', { error: err });
  }

  // io.close() disconnects every socket AND closes the underlying HTTP
  // server through the callback — calling server.close() as well would be a
  // double close.
  io.close((err) => {
    if (err) logger.warn('HTTP server was already closed', { error: err });
    server.closeIdleConnections?.();

    closeDatabase()
      .then(() => {
        logger.info('shutdown complete');
        // No process.exit() here: once every handle is closed the event loop
        // drains and Node exits on its own (code 0). Exiting in the middle of
        // the driver teardown aborts the process with a libuv assertion on
        // Windows ("UV_HANDLE_CLOSING ... async.c").
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function start() {
  try {
    await connectDB();
    startPresenceHeartbeat();

    // A port clash used to surface as an unhandled 'error' event with a raw
    // stack trace; report it the same way as any other boot failure.
    server.on('error', (err) => {
      if (err?.code === 'EADDRINUSE') {
        logger.error(
          `port ${env.PORT} is already in use - is another ChatWave server still running?`
        );
      } else {
        logger.error('HTTP server error', { error: err });
      }
      process.exit(1);
    });

    server.listen(env.PORT, () => {
      logger.info(`ChatWave API listening on http://localhost:${env.PORT}`, {
        env: env.NODE_ENV,
        clientOrigins: [...clientOrigins],
      });
    });
  } catch (err) {
    logger.error('failed to start the server', { error: err });
    process.exit(1);
  }
}

start();
