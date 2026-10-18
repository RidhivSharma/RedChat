import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// Workaround: some Windows networks advertise a link-local IPv6 DNS server
// (fe80::...) that Node's c-ares resolver cannot query. Every SRV lookup for a
// "mongodb+srv://" URI then fails with ECONNREFUSED. When that specific lookup
// fails we retry the connection once with public DNS servers.
const PUBLIC_DNS_FALLBACK = ['8.8.8.8', '8.8.4.4'];

const isSrvResolutionFailure = (err) =>
  typeof err?.message === 'string' && err.message.includes('querySrv');

function logConnected(conn) {
  logger.info('MongoDB connected', { host: conn.connection.host, db: conn.connection.name });
}

/**
 * Connects Mongoose to MongoDB with clear success/failure logging.
 * Logs host + database name only — never the full URI, which may contain
 * credentials. Rethrows on failure so the caller can exit.
 */
export async function connectDB() {
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });

  try {
    const conn = await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
    logConnected(conn);
    return conn;
  } catch (err) {
    if (!isSrvResolutionFailure(err)) {
      logger.error('MongoDB connection failed', { error: err });
      throw err;
    }

    logger.warn('SRV lookup failed - retrying with public DNS servers', {
      dnsServers: PUBLIC_DNS_FALLBACK,
      error: err,
    });
    dns.setServers(PUBLIC_DNS_FALLBACK);

    try {
      const conn = await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
      logConnected(conn);
      return conn;
    } catch (retryErr) {
      logger.error('MongoDB connection failed after DNS retry', { error: retryErr });
      throw retryErr;
    }
  }
}

export default connectDB;
