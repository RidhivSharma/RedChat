// ============================================================================
// API client request-shape tests — Node's built-in test runner.
//
// The API module is imported outside the browser here (api.js guards its
// `import.meta.env` reads), with a stubbed `fetch` that records the outgoing
// request. These tests pin the exact bodies the server contracts depend on.
//
// Regression covered: `conversationsApi.addMembers` once existed TWICE in
// api.js; the second definition (without `groupKeys`) silently won and dropped
// the wrapped group keys, so newly added members never received the current
// group key (and a REQUIRE_E2EE server rejects the call as INCOMPLETE_KEYS).
// Run with:  npm test   (in /client)
// ============================================================================

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { conversationsApi } from '../src/services/api.js';

const originalFetch = globalThis.fetch;

let requests;

beforeEach(() => {
  requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    };
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function lastRequest() {
  assert.equal(requests.length, 1, 'exactly one HTTP call must be made');
  return requests[0];
}

test('addMembers sends { userIds, groupKeys } so wrapped group keys reach the server', async () => {
  const groupKeys = [
    {
      userId: 'u2-u2-u2-u2-u2-u2',
      version: 1,
      wrappedKey: 'AAECAwQFBgcICQ==',
      iv: 'CgsMDQ4PEBES',
      wrappedBy: 'u1-u1-u1-u1-u1-u1',
    },
  ];

  await conversationsApi.addMembers('conv-1', ['u2-u2-u2-u2-u2-u2'], groupKeys);

  const { url, options } = lastRequest();
  assert.equal(url, '/api/conversations/conv-1/members');
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), {
    userIds: ['u2-u2-u2-u2-u2-u2'],
    groupKeys,
  });
});

test('addMembers without explicit keys still sends an empty groupKeys array', async () => {
  await conversationsApi.addMembers('conv-2', ['u9-u9-u9-u9-u9-u9']);

  const { options } = lastRequest();
  assert.deepEqual(JSON.parse(options.body), {
    userIds: ['u9-u9-u9-u9-u9-u9'],
    groupKeys: [],
  });
});

test('rotateKeys sends { baseVersion, groupKeys }', async () => {
  const groupKeys = [
    {
      userId: 'u1-u1-u1-u1-u1-u1',
      version: 2,
      wrappedKey: 'EREREREREREREQ==',
      iv: 'EhISEhISEhIS',
      wrappedBy: 'u1-u1-u1-u1-u1-u1',
    },
  ];

  await conversationsApi.rotateKeys('conv-3', 1, groupKeys);

  const { url, options } = lastRequest();
  assert.equal(url, '/api/conversations/conv-3/keys');
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), { baseVersion: 1, groupKeys });
});
