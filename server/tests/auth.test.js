import './helpers/setup.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { connectDB } from '../src/config/db.js';
import { env } from '../src/config/env.js';

let server;
let baseUrl;
let aliceToken;
let aliceId;
let bobId;

async function request(method, path, { token, json } = {}) {
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
}

async function dropTestDatabase() {
  if (!mongoose.connection.name.endsWith('_test')) {
    throw new Error(`Refusing to drop non-test database "${mongoose.connection.name}"`);
  }
  await mongoose.connection.dropDatabase();
}

before(async () => {
  await connectDB();
  await dropTestDatabase(); // start from a clean test database
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
  if (mongoose.connection.readyState !== 0) {
    await dropTestDatabase(); // clean up the test database
    await mongoose.disconnect();
  }
});

test('register: creates a user and returns token + public user only', async () => {
  const res = await request('POST', '/api/auth/register', {
    json: { username: 'Alice_01', displayName: 'Alice', password: 'password123' },
  });

  assert.equal(res.status, 201);
  assert.ok(res.body.token, 'expected a token');
  assert.equal(res.body.user.username, 'alice_01', 'username must be stored lowercase');
  assert.equal(res.body.user.displayName, 'Alice');
  assert.match(res.body.user.avatarColor, /^#[0-9a-f]{6}$/i);
  assert.equal(res.body.user.publicKey, null, 'publicKey is optional for now');
  assert.ok(!JSON.stringify(res.body).includes('passwordHash'), 'must never return passwordHash');

  aliceToken = res.body.token;
  aliceId = res.body.user.id;
});

test('register: rejects invalid input with VALIDATION_ERROR', async () => {
  const badUsername = await request('POST', '/api/auth/register', {
    json: { username: 'no spaces!', displayName: 'X', password: 'password123' },
  });
  assert.equal(badUsername.status, 400);
  assert.equal(badUsername.body.error.code, 'VALIDATION_ERROR');

  const shortPassword = await request('POST', '/api/auth/register', {
    json: { username: 'bob_02', displayName: 'Bob', password: 'short' },
  });
  assert.equal(shortPassword.status, 400);
  assert.equal(shortPassword.body.error.code, 'VALIDATION_ERROR');
});

test('register: rejects duplicate usernames regardless of case', async () => {
  const res = await request('POST', '/api/auth/register', {
    json: { username: 'ALICE_01', displayName: 'Alice Clone', password: 'password123' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'USERNAME_TAKEN');
  assert.match(res.body.error.message, /taken/i);
});

test('login: succeeds with correct credentials', async () => {
  const res = await request('POST', '/api/auth/login', {
    json: { username: 'alice_01', password: 'password123' },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.token, 'expected a token');
  assert.equal(res.body.user.username, 'alice_01');
  assert.ok('encryptedPrivateKey' in res.body);
  assert.equal(res.body.encryptedPrivateKey, null);

  aliceToken = res.body.token;
});

test('login: fails generically for wrong password and unknown user', async () => {
  const wrongPassword = await request('POST', '/api/auth/login', {
    json: { username: 'alice_01', password: 'wrong-password' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.error.message, 'Invalid username or password');
  assert.equal(wrongPassword.body.error.code, 'INVALID_CREDENTIALS');

  const unknownUser = await request('POST', '/api/auth/login', {
    json: { username: 'nobody_here', password: 'password123' },
  });
  assert.equal(unknownUser.status, 401);
  assert.equal(unknownUser.body.error.message, 'Invalid username or password');
  assert.equal(unknownUser.body.error.code, 'INVALID_CREDENTIALS');
});

test('protected routes: reject requests without a token', async () => {
  const me = await request('GET', '/api/auth/me');
  assert.equal(me.status, 401);
  assert.equal(me.body.error.code, 'AUTH_REQUIRED');

  const search = await request('GET', '/api/users/search?q=a');
  assert.equal(search.status, 401);
  assert.equal(search.body.error.code, 'AUTH_REQUIRED');
});

test('auth middleware: rejects invalid and expired tokens with clear codes', async () => {
  const invalid = await request('GET', '/api/auth/me', { token: 'not-a-real-jwt' });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.error.code, 'INVALID_TOKEN');

  const expiredToken = jwt.sign({ sub: aliceId }, env.JWT_SECRET, { expiresIn: '-10s' });
  const expired = await request('GET', '/api/auth/me', { token: expiredToken });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, 'TOKEN_EXPIRED');
});

test('me: returns the current user for a valid token', async () => {
  const res = await request('GET', '/api/auth/me', { token: aliceToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, aliceId);
  assert.equal(res.body.user.username, 'alice_01');
});

test('users search: prefix matches, excludes self, public fields only', async () => {
  const bob = await request('POST', '/api/auth/register', {
    json: { username: 'bob_02', displayName: 'Bob Builder', password: 'password123' },
  });
  assert.equal(bob.status, 201);
  bobId = bob.body.user.id;

  const res = await request('GET', '/api/users/search?q=b', { token: aliceToken });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.users));
  assert.ok(res.body.users.some((u) => u.username === 'bob_02'));
  assert.ok(res.body.users.every((u) => u.username !== 'alice_01'), 'must exclude current user');

  const expectedKeys = ['avatarColor', 'displayName', 'id', 'lastSeen', 'publicKey', 'username'];
  for (const user of res.body.users) {
    assert.deepEqual(Object.keys(user).sort(), [...expectedKeys].sort());
  }

  const noMatch = await request('GET', '/api/users/search?q=zzz', { token: aliceToken });
  assert.equal(noMatch.status, 200);
  assert.deepEqual(noMatch.body.users, []);
});

test('users search: escapes regex characters in the query', async () => {
  await request('POST', '/api/auth/register', {
    json: { username: 'sam_03', displayName: '(dev) Sam', password: 'password123' },
  });

  const res = await request(
    'GET',
    `/api/users/search?q=${encodeURIComponent('(dev')}`,
    { token: aliceToken }
  );
  assert.equal(res.status, 200);
  assert.ok(res.body.users.some((u) => u.username === 'sam_03'), 'literal "(" must match');
});

test('users by id: returns public profile, 400/404 for bad ids', async () => {
  const profile = await request('GET', `/api/users/${bobId}`, { token: aliceToken });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.username, 'bob_02');
  assert.ok(!('passwordHash' in profile.body.user));

  const invalid = await request('GET', '/api/users/not-an-object-id', { token: aliceToken });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');

  const missing = await request('GET', `/api/users/${new mongoose.Types.ObjectId()}`, {
    token: aliceToken,
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'USER_NOT_FOUND');
});

test('patch /users/me: updates displayName and avatarColor', async () => {
  const updated = await request('PATCH', '/api/users/me', {
    token: aliceToken,
    json: { displayName: 'Alice Wonder', avatarColor: '#10b981' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.user.displayName, 'Alice Wonder');
  assert.equal(updated.body.user.avatarColor, '#10b981');

  const me = await request('GET', '/api/auth/me', { token: aliceToken });
  assert.equal(me.body.user.displayName, 'Alice Wonder', 'update must persist');

  const empty = await request('PATCH', '/api/users/me', { token: aliceToken, json: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'VALIDATION_ERROR');
});
