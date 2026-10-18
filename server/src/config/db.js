import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';

// Workaround: some Windows networks advertise a link-local IPv6 DNS server
// (fe80::...) that Node's c-ares resolver cannot query. Every SRV lookup for a
// "mongodb+srv://" URI then fails with ECONNREFUSED. When that specific lookup
// fails we retry the connection once with public DNS servers.
const PUBLIC_DNS_FALLBACK = ['8.8.8.8', '8.8.4.4'];

const isSrvResolutionFailure = (err) =>
  typeof err?.message === 'string' && err.message.includes('querySrv');

function logConnected(conn) {
  console.log(`[db] MongoDB connected: host=${conn.connection.host} db=${conn.connection.name}`);
}

/**
 * Connects Mongoose to MongoDB with clear success/failure logging.
 * Logs host + database name only — never the full URI, which may contain
 * credentials. Rethrows on failure so the caller can exit.
 */
export async function connectDB() {
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('[db] MongoDB reconnected');
  });

  try {
    const conn = await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
    logConnected(conn);
    return conn;
  } catch (err) {
    if (!isSrvResolutionFailure(err)) {
      console.error(`[db] MongoDB connection failed: ${err.message}`);
      throw err;
    }

    console.warn(
      `[db] SRV lookup failed (${err.message}); retrying with DNS servers ${PUBLIC_DNS_FALLBACK.join(', ')}`
    );
    dns.setServers(PUBLIC_DNS_FALLBACK);

    try {
      const conn = await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
      logConnected(conn);
      return conn;
    } catch (retryErr) {
      console.error(`[db] MongoDB connection failed: ${retryErr.message}`);
      throw retryErr;
    }
  }
}

export default connectDB;
