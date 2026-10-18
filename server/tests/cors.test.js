// Deployment CORS: CLIENT_URL may be a comma-separated list of origins, and
// both Express and the Socket.io handshake must honour every entry. The list
// is read once at import time, so the environment is set before src modules
// are imported (dynamic import below).
import './helpers/setup.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLIENT_URL = ' http://localhost:5173 , https://redchat.example/ , https://preview.example';

const { clientOrigins, env, parseClientOrigins } = await import('../src/config/env.js');
const { default: app } = await import('../src/app.js');
const { attachSockets } = await import('../src/sockets/index.js');
const { startTestServer, stopTestServer } = await import('./helpers/harness.js');

const ALLOWED = 'https://redchat.example';
const ALLOWED_SECOND = 'https://preview.example';
const BLOCKED = 'https://evil.example';

let server;
let ioServer;
let baseUrl;

before(async () => {
  const started = await startTestServer(app);
  server = started.server;
  baseUrl = started.baseUrl;
  ioServer = attachSockets(server);
});

after(async () => {
  ioServer.close();
  await stopTestServer(server);
});

test('parseClientOrigins trims, strips trailing slashes and drops empties', () => {
  assert.deepEqual(parseClientOrigins(' http://a , https://b/ ,, '), ['http://a', 'https://b']);
  assert.deepEqual(parseClientOrigins(''), []);
});

test('env normalizes CLIENT_URL into a list of origins', () => {
  assert.deepEqual(clientOrigins, ['http://localhost:5173', ALLOWED, ALLOWED_SECOND]);
  assert.equal(env.CLIENT_URL, 'http://localhost:5173,https://redchat.example,https://preview.example');
});

test('Express CORS allows every configured origin and nothing else', async () => {
  for (const origin of clientOrigins) {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
  }

  const blocked = await fetch(`${baseUrl}/api/health`, { headers: { origin: BLOCKED } });
  assert.equal(blocked.status, 200); // no CORS headers, but the app still answers
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);

  // Preflight for the deployed origins succeeds.
  const preflight = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      origin: ALLOWED_SECOND,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.ok(preflight.status === 204 || preflight.status === 200, `status ${preflight.status}`);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_SECOND);
});

test('Socket.io handshake uses the same origin list', async () => {
  for (const origin of [ALLOWED, ALLOWED_SECOND]) {
    const res = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin },
    });
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      origin,
      `socket handshake must allow ${origin} (status ${res.status})`
    );
  }

  const blocked = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
    headers: { origin: BLOCKED },
  });
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
});
