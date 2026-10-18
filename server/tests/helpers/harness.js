// Shared HTTP/db helpers for integration tests.
import http from 'node:http';
import mongoose from 'mongoose';

/** JSON fetch helper bound to a test server's base URL. */
export function createRequester(baseUrl) {
  return async function request(method, path, { token, json } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

export async function startTestServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

export async function stopTestServer(server) {
  if (!server) return;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

export async function dropTestDatabase() {
  if (!mongoose.connection.name.endsWith('_test')) {
    throw new Error(`Refusing to drop non-test database "${mongoose.connection.name}"`);
  }
  await mongoose.connection.dropDatabase();
}
