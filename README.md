# ChatWave

Real-time chat app with one-on-one and group chat, online status, typing
indicators, read receipts and end-to-end encryption.

**Stack:** React (Vite, JavaScript) · Node.js + Express · Socket.io · MongoDB + Mongoose ·
browser Web Crypto API (no crypto libraries on the client).

- [Overview](#overview)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Security](#security)
- [Folder structure](#folder-structure)
- [Environment variables](#environment-variables)
- [Running locally](#running-locally)
- [Running tests](#running-tests)
- [Socket.io event reference](#socketio-event-reference)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

## Overview

ChatWave is a full-stack, end-to-end encrypted messenger. People register an
account (which generates an ECDH P-256 key pair **in the browser**), find each
other by username, and chat one-on-one or in groups. Messages are encrypted with
AES-GCM-256 before they leave the browser, so the server stores and relays only
ciphertext — it can never read a message. The app also tracks presence (online /
last seen), typing state, delivery and read receipts, unread counts, group
membership and key rotation, all in real time over Socket.io.

Everything runs from one repository:

- `/server` — the Express + Socket.io API (ES modules, Mongoose models, JWT auth).
- `/client` — the React single-page app (Vite, plain CSS, Web Crypto E2EE).
- Root `package.json` — convenience scripts that run both together.

The security design and its limits are documented in the [Security](#security)
section — read it before deploying anywhere public.

## Features

**Accounts & sessions**
- Register / login / logout with bcryptjs-hashed passwords and JWT sessions.
- Session survives a page refresh; an expired or invalid token (REST *or*
  socket) force-logs the user out with an explanation.
- Rate-limited auth routes and a baseline API rate limit.

**Direct chat**
- Search users by username or display name and start (or reopen) a direct chat
  in one click — direct conversations are de-duplicated by a canonical
  `directKey`.
- Real-time send/receive with optimistic bubbles: sending → sent → delivered →
  read, with an inline retry (the same `clientId` is deduplicated server-side,
  so a retry can never create a duplicate message).
- Infinite scroll-up through history with cursor pagination; the scroll position
  is preserved while older pages load.

**Group chat**
- Create groups (name + multi-select members), rename, add/remove members,
  promote admins, leave.
- The creator is the only admin initially; a group always keeps at least one
  admin (the earliest member is promoted automatically if the last admin
  leaves).
- Server-generated system lines for every membership change ("Alex added Sam").

**End-to-end encryption**
- ECDH P-256 key pairs generated in the browser; AES-GCM-256 per message with a
  fresh random IV.
- Direct chats derive a shared key from both public keys; groups use a random
  group key that is wrapped separately for every member.
- Removed members can no longer read new messages: an admin's client creates the
  next key version and uploads wrapped keys for the remaining members.
- Key backup: the private key is stored non-extractable in IndexedDB on this
  device and additionally kept on the server **encrypted with a key derived from
  the user's password** (PBKDF2-SHA256, 310,000 iterations) so it can be
  restored on a new device.
- "Verify encryption" dialog with SHA-256 key fingerprints (direct: one pair
  fingerprint; group: per-member fingerprints).

**Realtime presence & feedback**
- Online dot, `last seen …` timestamps, live typing indicators ("Alex is
  typing… / Alex and Sam are typing… / Several people are typing…").
- Delivered and read ticks (grey single = sent, grey double = delivered, blue
  double = read; in groups only when *every* other member is there), plus a
  per-member message info dialog.
- Unread badges per conversation and a `(n)` prefix on the browser tab title.
- Opt-in desktop notifications (never contain message text), per-conversation
  mute, and a connection banner while reconnecting.

**Polish**
- Light/dark theme (no flash on load), fully responsive down to 360 px (one pane
  at a time on mobile), accessible focus/contrast, toasts.

## Tech stack

| Layer | Choice |
| ----- | ------ |
| Client | React 19, Vite, React Router, plain CSS with CSS variables (no UI library, no Tailwind) |
| Realtime client | `socket.io-client` |
| Crypto | Browser Web Crypto API (`window.crypto.subtle`) only — no crypto libraries |
| Server | Node.js, Express 5, zod validation |
| Realtime server | Socket.io (JWT-authenticated handshake) |
| Database | MongoDB with Mongoose |
| Auth | JSON Web Tokens (`Authorization: Bearer`) + bcryptjs |
| Security middleware | helmet, cors, express-rate-limit |
| Tests | Node's built-in test runner (`node:test`), `socket.io-client` for socket tests |
| Dev tooling | nodemon, concurrently |

Only these packages are used, on purpose (see `AGENTS.md`).

## Architecture

The client is a single-page app. All HTTP traffic goes through
`client/src/services/api.js`; all realtime traffic goes through
`client/src/services/socket.js`. That keeps the two channels interchangeable:
anything that must survive a refresh or be safe to retry is REST, anything that
must feel instant is Socket.io.

### REST vs Socket.io responsibilities

**REST (`/api`, JSON over HTTPS)** — request/response state and history:

| Concern | Endpoints |
| ------- | --------- |
| Accounts & sessions | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` |
| Users | `GET /api/users/search?q=`, `GET /api/users/:id`, `PATCH /api/users/me` |
| Conversations | `POST /api/conversations/direct`, `POST /api/conversations/group`, `GET /api/conversations`, `GET /api/conversations/:id` |
| History & fallback send | `GET /api/conversations/:id/messages?before=&limit=`, `POST /api/conversations/:id/messages` |
| Group admin actions | `POST /api/conversations/:id/members`, `DELETE /api/conversations/:id/members/:userId`, `PATCH /api/conversations/:id`, `POST /api/conversations/:id/admins` |
| Group key rotation | `POST /api/conversations/:id/keys` |
| Delete for everyone | `DELETE /api/messages/:id` |
| Health | `GET /api/health` |

Rules that apply to every endpoint: JWT in the `Authorization: Bearer` header,
the user id always taken from the verified token (never from the request body),
every body/query validated with zod, membership checked before any data is
touched, and errors always shaped as
`{ "error": { "message": "…", "code": "…" } }`.

**Socket.io (`/socket.io`) — live state and events:**

- Presents connected sockets; connects/disconnects drive online status and
  `last seen`.
- Delivers messages in real time (`message:new`) and receipt changes
  (`message:status`, `messages:read`).
- Relays typing indicators.
- Pushes membership changes (`conversation:new`, `conversation:updated`,
  `conversation:removed`) and key material (`conversation:keys`,
  `conversation:rotate-key`).
- Every socket authenticates in the handshake with the same JWT
  (`auth: { token }`); the verified user id is stored in `socket.data.userId`.
- Every event validates its payload with zod and checks conversation membership.
- Every client emit that needs a result uses an acknowledgement callback: the
  server answers `{ ok: true, data }` on success and
  `{ ok: false, error: { message, code } }` on failure.
- The REST create-message endpoint exists as a fallback for tests/clients that
  do not hold a socket; it reuses the exact same message service.

Rooms: one room per user (`user:<id>`, for personal, key-bearing payloads) and
one room per conversation (`conv:<id>`, for broadcasts). Members join their rooms
when they connect; group adds/removes make sockets join/leave.

### Data models

Three Mongoose collections (see `server/src/models/`). Private fields (marked
*below*) never appear in an API response.

**User**

| Field | Type | Notes |
| ----- | ---- | ----- |
| `username` | String | unique, lowercased, used for login |
| `displayName` | String | shown in the UI |
| `passwordHash` | String | bcryptjs, 10 rounds — *never exposed* |
| `avatarColor` | String | hex color for the initials avatar |
| `publicKey` | String \| null | ECDH P-256 JWK, shareable |
| `encryptedPrivateKey` | `{ ciphertext, iv, salt, iterations }` | password-wrapped backup — *returned only to its owner* |
| `lastSeen` | Date | updated on disconnect and by a 5-minute heartbeat |
| `createdAt` | Date | timestamps |

**Conversation**

| Field | Type | Notes |
| ----- | ---- | ----- |
| `type` | `"direct" \| "group"` | |
| `members` | `[User]` | index `{ members: 1, lastMessageAt: -1 }` |
| `directKey` | String | sorted member ids joined — unique + sparse, only for direct chats (makes "find or create" idempotent) |
| `name` | String | groups only (max 50) |
| `admins` | `[User]` | groups; always ≥ 1 |
| `createdBy` | `User` | |
| `groupKeys` | `[{ userId, version, wrappedKey, iv, wrappedBy }]` | one envelope per member per key version; only the member's own envelopes are ever serialized to them |
| `currentKeyVersion` | Number | bumped on every group-key rotation |
| `lastMessageAt` / `lastMessageId` | Date / Message | sidebar ordering + last-message preview |
| `createdAt` | Date | |

`unreadCount` is **not** stored — it is computed per viewer from the `Message`
collection on every list/get request, using the same filter the read path
writes, so badges can never drift.

**Message**

| Field | Type | Notes |
| ----- | ---- | ----- |
| `conversationId` | Conversation | |
| `sender` | User | |
| `ciphertext` | String | encrypted payload (web Crypto AES-GCM); plain text only for `type: "system"` |
| `iv` | String \| null | fresh 12-byte IV per message (base64) |
| `keyVersion` | Number | which group key version was used |
| `encrypted` | Boolean | false only for legacy/plaintext or system messages |
| `type` | `"user" \| "system"` | system = group activity line |
| `clientId` | String | client-generated; unique per sender, makes sends idempotent |
| `deliveredTo` | `[{ user, at }]` | delivery receipts |
| `readBy` | `[{ user, at }]` | read receipts (a read implies delivered) |
| `deletedForEveryone` | Boolean | content is never serialized once true |
| `createdAt` | Date | |

Indexes: `{ conversationId, createdAt: -1, _id: -1 }` (history pagination),
`{ conversationId, 'deliveredTo.user' }` (delivery catch-up),
`{ sender, clientId }` unique (deduplication),
`{ conversationId, sender, 'readBy.user' }` (unread counts).

## Security

Messages are end-to-end encrypted in the browser with the Web Crypto API
(`crypto.subtle`). Set `REQUIRE_E2EE=true` in the server environment to make the
server refuse unencrypted messages and registrations without key material.

### What is protected

- **Message text.** Each message is encrypted with AES-GCM-256 and a fresh random
  12-byte IV before it leaves the browser. The server stores and relays only
  `ciphertext`, `iv` and the key version. It never receives message text, and it
  stores no plaintext previews — the sidebar preview is decrypted on your device.
- **Direct chats.** Every user has an ECDH P-256 key pair. Both people derive the
  same AES key from *their private key × the other's public key*.
- **Group chats.** A random AES-GCM-256 group key is wrapped separately for every
  member with an ECDH-derived key. Every message carries its `keyVersion`, so old
  messages stay readable. When a member is removed or leaves, an admin's client
  creates a new key version for the remaining members.
- **Your private key.** On this device it is a non-extractable `CryptoKey` in
  IndexedDB (a page refresh needs no password; logout deletes it). The server
  holds only a copy encrypted with a key derived from your password
  (PBKDF2-SHA256, 310,000 iterations, random salt; AES-GCM-256), so you can restore
  it on a new device.
- **Verification.** *Verify encryption* in the chat header shows a SHA-256
  fingerprint of both public keys. Compare it with your contact over a channel you
  trust (in person, a call) to detect a swapped key.

### Limitations

- **Password-wrapped key backup.** The server stores your encrypted private key.
  Its only protection is your password, so a malicious server operator (or anyone
  who gets the database) can try to brute-force it offline. Weak passwords will
  fall; the 310,000 PBKDF2 iterations only slow this down. Use a long, unique
  password. Forgetting it means the backup cannot be recovered.
- **Metadata is not hidden.** The server knows who talks to whom, which groups
  exist and who is in them, message sizes and timestamps, delivery/read receipts,
  online status and typing activity.
- **Removed members keep what they already had.** A new key version stops a removed
  member from reading *future* messages, but they keep the old keys and any
  messages they already received. Messages cannot be un-shared.
- **Trust in the server for public keys.** A malicious server could hand out a
  substitute public key. Only the *Verify encryption* comparison detects this.
- **No forward secrecy.** Keys are long-lived; if a private key (or password) is
  compromised, past messages encrypted with keys derived from it can be read.
- **The web app itself is trusted code.** A compromised server or XSS could ship
  JavaScript that reads messages before they are encrypted. A non-extractable key
  prevents exporting the key, not using it from inside the page.
- Accounts created before encryption existed get keys generated on their next
  login; until then they cannot send.

Server-side hardening that complements the E2EE design: bcryptjs password
hashing, JWT-only identity, helmet, CORS restricted to `CLIENT_URL`, rate limits
on auth routes and the API, zod validation on every body/query/socket payload,
100 kB request bodies, capped key-envelope lengths, a log serializer that
redacts secrets and never logs message content, and safe error messages in
production.

## Folder structure

```
Chat App/
├── package.json              # root scripts: dev (both), build (client), start (server), test
├── README.md                 # this file
├── QA_CHECKLIST.md           # manual test checklist
├── CHANGELOG.md              # what changed per phase
├── AGENTS.md                 # project rules
│
├── server/
│   ├── src/
│   │   ├── config/           # env.js (zod-validated env), db.js (Mongoose connect)
│   │   ├── controllers/      # auth, user, conversation, message handlers
│   │   ├── middleware/       # auth (JWT), validate (zod), rateLimit
│   │   ├── models/           # User, Conversation, Message (+ barrel)
│   │   ├── routes/           # /api routers
│   │   ├── sockets/          # index (attach + handshake auth), presence, messages,
│   │   │                     # receipts, typing, conversations, rooms, helpers, rateLimit
│   │   ├── utils/            # AppError, logger, messageService, receiptService, serialize, …
│   │   ├── app.js            # Express app (helmet, CORS, routes, error shape)
│   │   └── server.js         # HTTP + Socket.io bootstrap, graceful shutdown
│   ├── tests/                # node:test integration suite (+ helpers/)
│   └── .env.example
│
└── client/
    ├── public/               # favicon.svg, _redirects (Netlify SPA fallback)
    ├── src/
    │   ├── components/       # UI pieces (Sidebar, ChatWindow, dialogs, …)
    │   ├── context/          # Auth, Socket, Chat, Toast providers
    │   ├── hooks/            # useAuth, useSocket, useChat, useTheme, useDecryptedText, …
    │   ├── pages/            # LoginPage, RegisterPage, ChatPage, NotFoundPage
    │   ├── services/         # api.js (all HTTP), socket.js (all Socket.io)
    │   ├── styles/           # global.css (design tokens, light/dark, responsive)
    │   └── utils/            # crypto/ (Web Crypto E2EE), formatting, validation
    ├── tests/                # node:test crypto + API contract tests
    ├── vercel.json           # SPA rewrite for Vercel
    ├── vite.config.js
    └── .env.example
```

## Environment variables

No real values are committed; `.env` files are gitignored, and examples live in
`server/.env.example` and `client/.env.example`. Only `VITE_`-prefixed client
variables reach the browser bundle — never put secrets in `client/.env`.

### Server (`server/.env`, or a repo-root `.env` as fallback)

| Variable | Required | Example | Description |
| -------- | -------- | ------- | ----------- |
| `PORT` | no | `5000` | HTTP/Socket.io port. The server binds this port (`process.env.PORT`) — deployment platforms inject it. |
| `NODE_ENV` | no | `development` | `development` \| `production` \| `test`. Enables JSON logging, safe error messages and the production shutdown path. |
| `MONGODB_URI` | **yes** | `mongodb+srv://user:pass@cluster/chatwave` | MongoDB connection string **including the database name**. Percent-encode special characters in the password (`@` → `%40`). |
| `JWT_SECRET` | **yes** | 32+ random chars | Signing secret for access tokens. Use a long random value; changing it logs everyone out. |
| `JWT_EXPIRES_IN` | no | `7d` | Token lifetime (any `jsonwebtoken` duration). |
| `CLIENT_URL` | no | `http://localhost:5173` | Origin(s) allowed by CORS, for **both** Express and Socket.io. Comma-separated list supported (`http://localhost:5173,https://chatwave.vercel.app`). Exact origin, no trailing slash. |
| `REQUIRE_E2EE` | no | `false` | `true` makes the server reject plaintext messages and registrations without key material. Set to `true` in production. |

### Client (`client/.env`)

| Variable | Required | Example | Description |
| -------- | -------- | ------- | ----------- |
| `VITE_API_URL` | **yes** | `http://localhost:5000/api` | Base URL of the REST API, **including the `/api` prefix**. Inlined at build time. |
| `VITE_SOCKET_URL` | **yes** | `http://localhost:5000` | Origin of the Socket.io server — the server URL **without** `/api`. Inlined at build time. |

Changing a `VITE_*` value requires a rebuild/redeploy; it is baked into the
bundle, not read at runtime.

## Running locally

### 1. Database — MongoDB Atlas or a local MongoDB

**MongoDB Atlas (no local install):**

1. Create a free cluster at <https://cloud.mongodb.com>.
2. *Database Access* → add a user with a password (percent-encode special
   characters when you paste the password into the URI).
3. *Network Access* → add your current IP address (or `0.0.0.0/0` during
   development; see [Deployment](#deployment) for hosts).
4. *Connect → Drivers* → copy the `mongodb+srv://…` string and add a database
   name to the path, e.g. `mongodb+srv://user:pass@cluster0.abcde.mongodb.net/chatwave`.

**Local MongoDB:** install MongoDB Community Server and use
`mongodb://127.0.0.1:27017/chatwave` — no network access rules involved.

### 2. Install

```bash
npm install                  # root (concurrently)
npm install --prefix server  # API server
npm install --prefix client  # web client
```

### 3. Configure

```bash
cp server/.env.example server/.env   # then set MONGODB_URI and JWT_SECRET
cp client/.env.example client/.env   # defaults match the dev server on :5000
```

Generate a JWT secret, for example:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Run

```bash
npm run dev
```

This starts both processes with `concurrently`:

- API + Socket.io on <http://localhost:5000> (`GET /api/health` → `{"status":"ok"}`)
- Vite dev server on <http://localhost:5173> — open this URL, register two
  accounts (two browser profiles or one normal + one private window) and chat.

Other scripts:

| Script | Where | What it does |
| ------ | ----- | ------------ |
| `npm run dev` | root | `nodemon` server + Vite dev server together |
| `npm run build` | root | production build of the client into `client/dist` |
| `npm start` | root | runs the server (`node server/src/server.js`) |
| `npm test` | root | server tests, then client tests |
| `npm run dev` / `npm start` | `server/` | nodemon / plain node |
| `npm run dev` / `npm run build` / `npm run preview` | `client/` | Vite dev / build / preview the build |

## Running tests

Tests use Node's built-in runner (`node:test`) — no test framework is installed.

```bash
npm test                    # both suites (server then client), from the root
npm test --prefix server    # API + socket integration tests (needs MongoDB)
npm test --prefix client    # crypto + API-contract unit tests (no database)
```

- **Server tests** (`server/tests/`) run against a real MongoDB. They derive a
  separate database from `MONGODB_URI` by appending `_test` (e.g.
  `chatwave` → `chatwave_test`), create and then **drop** it on every run, and
  refuse to drop anything that does not end in `_test`. Point them at a local
  MongoDB or an Atlas cluster you do not mind wiping. Suites cover auth,
  conversations, message service, socket auth/presence/messaging, receipts,
  groups, E2EE enforcement, CORS and security hardening.
- **Client tests** (`client/tests/`) cover the Web Crypto module (round trips,
  group key wrapping, fingerprints, password backup) and the `addMembers` /
  `rotateKeys` request bodies. They need no MongoDB and no browser.

Both are also runnable directly with the runner, e.g.
`node --test tests/crypto.test.js` inside `client/`.

## Socket.io event reference

Handshake: the client connects with `auth: { token }` (the same JWT as REST). A
bad/expired token is rejected with a `connect_error` carrying
`err.data.code` (`AUTH_REQUIRED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`,
`AUTH_FAILED`).

**Event reference**

| Event | Direction | Payload | Ack | Notes |
| ----- | --------- | ------- | --- | ----- |
| `message:send` | client → server | `{ conversationId, clientId, ciphertext, iv?, keyVersion?, encrypted? }` | `{ ok: true, data: { message } }` / `{ ok: false, error: { message, code } }` | Membership-checked, zod-validated. A retry with the same `clientId` acks the original message without re-broadcasting. Rate limit 20 / 10 s. |
| `message:delete` | client → server | `{ messageId }` | `{ ok: true, data: { message } }` | Sender only; system messages are rejected (`SYSTEM_MESSAGE`). |
| `message:delivered` | client → server | `{ conversationId, messageIds? }` | `{ ok: true, data: { delivered } }` | Omit `messageIds` to mark every undelivered message in the conversation. Max 200 ids. |
| `message:read` | client → server | `{ conversationId, upToMessageId }` | `{ ok: true, data: { readCount, deliveredCount, at } }` | Marks everything from others at/up to that message; a read implies delivered. |
| `typing:start` | client → server | `{ conversationId }` | `{ ok: true, data: {} }` | Relayed to the other members only; repeated states are no-ops. |
| `typing:stop` | client → server | `{ conversationId }` | `{ ok: true, data: {} }` | Same as above with `isTyping: false`. |
| `message:new` | server → client | `{ message }` | — | New message (encrypted `ciphertext` + `iv`) or system line, to the conversation room. |
| `message:deleted` | server → client | `{ conversationId, messageId }` | — | Deleted for everyone. |
| `message:status` | server → client | `{ conversationId, messageId, deliveredTo, readBy }` | — | One event per message whose delivery state changed. |
| `messages:read` | server → client | `{ conversationId, userId, upToMessageId, upToMessageAt, at, readCount, deliveredCount }` | — | Batched read receipt (one event per read, not per message). |
| `typing` | server → client | `{ conversationId, userId, isTyping }` | — | The sender's own sockets are excluded. |
| `presence:update` | server → client | `{ userId, online, lastSeen? }` | — | First socket connects / last socket disconnects; `lastSeen` only when going offline. |
| `presence:snapshot` | server → client | `{ users: [{ userId, online }] }` | — | Sent once per connection: everyone the user shares a conversation with. |
| `conversation:new` | server → client | `{ conversation }` | — | Personalized: own group key envelopes; sent on creation and to a newly added member. |
| `conversation:updated` | server → client | `{ conversation }` | — | Room-wide membership/name/admin change (no `unreadCount`, no keys). |
| `conversation:removed` | server → client | `{ conversationId, left }` | — | The user was removed (`left: false`) or left voluntarily (`left: true`). |
| `conversation:keys` | server → client | `{ conversationId, currentKeyVersion, groupKeys }` | — | Only the recipient's own wrapped envelopes, after a rotation. |
| `conversation:rotate-key` | server → client | `{ conversationId, baseVersion, removedUserId }` | — | Asks remaining admins' clients to create the next key version. |

Common ack error codes: `VALIDATION_ERROR`, `NOT_A_MEMBER`, `NOT_GROUP_ADMIN`,
`MESSAGE_NOT_FOUND`, `SYSTEM_MESSAGE`, `ENCRYPTION_REQUIRED`, `RATE_LIMITED`,
`AUTH_REQUIRED`.

## Deployment

Two services: the **API/socket server** (needs a long-lived process) and the
**static client**.

> **The Socket.io server cannot run on Vercel or Netlify.** Their serverless
> functions do not support long-lived WebSocket connections, which ChatWave
> relies on for messaging, typing, presence and receipts. Host the server on a
> platform with persistent processes — **Render** or **Railway** — and only the
> client on Vercel/Netlify.

### 1. Server on Render (or Railway)

1. Push the repository to GitHub and create a **Web Service** from it.
2. Settings (monorepo):
   - **Root directory:** repository root
   - **Build command:** `npm install --prefix server`
   - **Start command:** `npm --prefix server start` (or `npm start` from the
     repo root, which runs the same command)
   - **Health check path:** `/api/health`
3. Environment variables:

   | Variable | Value |
   | -------- | ----- |
   | `MONGODB_URI` | your Atlas connection string **with** the database name (`…/chatwave`) |
   | `JWT_SECRET` | long random string (32+ chars, different from dev) |
   | `JWT_EXPIRES_IN` | `7d` (or your preference) |
   | `CLIENT_URL` | the deployed client URL, e.g. `https://chatwave.vercel.app` (no trailing slash; comma-separate extra origins such as preview URLs) |
   | `NODE_ENV` | `production` |
   | `REQUIRE_E2EE` | `true` |

   Do **not** set `PORT` — Render/Railway inject it and the server binds
   `process.env.PORT`.
4. Deploy and check `https://<your-service>/api/health` → `{"status":"ok"}`.
   Render terminates TLS at its proxy; the app already calls
   `app.set("trust proxy", 1)` so rate limiting and socket IPs stay correct
   behind it.

Railway is equivalent: build `npm install --prefix server`, start
`npm --prefix server start`, same variables. Both support WebSockets out of the
box.

### 2. Client on Vercel (or Netlify)

1. Create a project from the same repository.
2. **Vercel:** set **Root Directory** to `client`. Framework preset *Vite*,
   build command `npm run build`, output directory `dist`. `client/vercel.json`
   rewrites every path to `/index.html` so client-side routes like `/login`
   work on refresh.
   **Netlify:** base directory `client`, build command `npm run build`, publish
   directory `client/dist`. `client/public/_redirects` (`/* /index.html 200`)
   is copied into the build and handles SPA routing.
3. Environment variables (set them **before** the build — Vite inlines them):

   | Variable | Value |
   | -------- | ----- |
   | `VITE_API_URL` | server URL **+ `/api`**, e.g. `https://chatwave-api.onrender.com/api` |
   | `VITE_SOCKET_URL` | server URL **without** `/api`, e.g. `https://chatwave-api.onrender.com` |

4. Deploy, then go back to the server’s `CLIENT_URL` and make sure it matches
   the deployed client origin exactly (scheme + host, no trailing slash). Changing
   either side requires a redeploy/restart of that side.

### 3. MongoDB Atlas network access

In Atlas → *Network Access*, allow the deployment host’s IPs. Free/starter
plans (Render, Railway, Vercel) do not give a stable outbound IP, so the common
choice is `0.0.0.0/0` (allow from anywhere) while keeping a strong database
password — or the platform’s static IP add-on if you have one. Restricting to
your own laptop IP will break the deployed server with a connection timeout.

### 4. Free-tier caveats

- **Run a single server instance.** Presence and socket rooms live in memory
  (single process by design — see `server/src/sockets/presence.js`), so scaling
  to several instances without a shared adapter (e.g. Redis) would split
  presence and room membership. One instance serves the whole app fine.
- Free instances **sleep** after inactivity. The first request (and the first
  socket connection) can take 30–60 s while the service wakes — the client shows
  the connection banner and reconnects automatically, but a chat sent during the
  cold start may take an extra moment to appear. Open the client once before
  demonstrating.
- Sleeping also drops sockets: presence briefly shows everyone offline and comes
  back when clients reconnect.
- Free tiers have bandwidth/hours limits — fine for a demo, check the quota for
  anything else.

## Troubleshooting

### "Cannot connect to MongoDB" / server exits at boot

- The server logs `MongoDB connection failed` and exits 1. Read the line above:
  it never prints the URI, but the error tells you what failed.
- **Wrong credentials or unencoded characters.** Special characters in the
  password must be percent-encoded: `@` → `%40`, `:` → `%3A`, `/` → `%2F`,
  `?` → `%3F`, `#` → `%23`. The app fixes an unencoded `@` in memory and warns,
  but fix the `.env` properly.
- **No database name in the path.** `mongodb+srv://host/` makes the driver use a
  database literally named `test` (the server warns about this). Add `/chatwave`.
- **Atlas Network Access.** Your IP (or `0.0.0.0/0` for deployed hosts) must be
  allowed; otherwise the connection times out after 10 s.
- **`querySrv … ECONNREFUSED` on Windows.** Some networks advertise a link-local
  IPv6 DNS server the driver can’t query. `server/src/config/db.js` already
  retries once with `8.8.8.8`, but if it still fails, fix your DNS or use a
  non-SRV (`mongodb://`) string.
- **Local MongoDB not running.** Start the service, or point `MONGODB_URI` at
  Atlas.

### CORS errors in the browser console

Symptom: the request fails with "No 'Access-Control-Allow-Origin' header is
present" — the API might even log a 200.

- `CLIENT_URL` must match the browser **origin exactly**: scheme + host + port,
  no path, no trailing slash. `http://localhost:5173` ≠ `http://127.0.0.1:5173`.
- Vite falls back to `5174`/`5175` when 5173 is busy — add those origins (a
  comma-separated list is supported) or free the port.
- Multiple clients (local + deployed)? List them all:
  `CLIENT_URL=http://localhost:5173,https://chatwave.vercel.app`.
- Restart the server after changing `CLIENT_URL`; it is read at boot for both
  Express and Socket.io.
- Beware: an origin that is *not* allowed gets **no** CORS headers at all (the
  request may still return 200) — that is the intended block, not a bug.

### Socket not connecting (banner stays "Connecting…" / "Offline")

- `VITE_SOCKET_URL` must be the server **origin only** — no `/api`, no trailing
  slash (`https://chatwave-api.onrender.com`). `VITE_API_URL` is the one with
  `/api`.
- `VITE_*` variables are baked in at build time: after changing them you must
  rebuild/redeploy the client (restart `npm run dev` locally).
- Check the server is reachable: open `/api/health` from the same browser.
- **Hosted on Vercel/Netlify/serverless?** WebSockets cannot work there — move
  the server to Render/Railway (see [Deployment](#deployment)).
- A `connect_error` with `TOKEN_EXPIRED`/`INVALID_TOKEN` means the session is
  over — log in again. The client handles this by itself.
- Behind a custom reverse proxy, enable WebSocket upgrade headers
  (`Upgrade`/`Connection`) and disable buffering for `/socket.io`.
- On a sleeping free instance the first connect can take 30–60 s; the client
  keeps retrying with backoff.

### Messages show "Unable to decrypt this message"

The bubble renders a deliberately non-throwing placeholder when decryption
fails. In development the browser console logs a one-time
`DECRYPTION_FAILURE <reason>` warning (reason only — never keys or content).

- **No private key on this device.** A new device/browser profile or cleared
  site data shows the unlock screen: enter your password to restore the key from
  the server backup. Without it you cannot read old messages.
- **Wrong password when restoring.** The restored key is checked against the
  account’s published public key; a mismatch is rejected and asked for again.
- **A member’s public key is missing.** Accounts created before E2EE publish a
  key only at their next login. The client refetches conversation keys when a
  decryption fails — reopen the conversation, or have that account log out and
  back in once.
- **Messages from before the account had keys** (legacy plaintext is rare) or
  created with a key version your device does not hold cannot be read.
- **Deleted for everyone** messages deliberately show no content at all.
- Sending much later: if *your* send fails with a key error, the composer
  re-fetches the conversation keys and retries.
- If exactly one side consistently fails, compare the *Verify encryption*
  fingerprint on both devices — different fingerprints mean a stale/replaced key
  and the account should log in again on the affected device.

### Read receipts not updating

- The recipient must have the conversation **open**, the tab **visible** (a
  background tab does not count messages as read) and the message list scrolled
  **near the bottom**. Scroll to the newest message.
- You cannot read your own messages: ticks on your message turn blue only after
  the *other* account reads it. To test locally use two different accounts (for
  example one normal window + one private window), not two tabs of the same
  account.
- In a group, the blue double tick appears only when **every** other member has
  read the message; the info dialog (click the ticks) lists who has delivered
  and who has read, so use it to find the missing person.
- Grey double tick = delivered. A recipient who was offline is marked delivered
  when they next connect (or immediately if they are online). If nothing moves,
  check the recipient’s socket is connected (their window shows no connection
  banner).
- Receipts need a live socket for the *updates*; a refresh always shows the
  persisted state from MongoDB.

## License

Internal/educational project — no license file included.
