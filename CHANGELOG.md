# Changelog

All notable changes are grouped by phase.

## Phase 1 — Backend foundation (2026-10-17)

**Root workspace**
- `package.json`: `dev` (concurrently — server + client once it exists), `build` (client build), `start` (runs server).
- `.gitignore`: node_modules, .env files (`.env.example` kept), dist, logs.
- Installed `concurrently` (dev).

**Server** (`/server`, ES modules)
- Installed express, mongoose, socket.io, jsonwebtoken, bcryptjs, cors, dotenv, helmet, express-rate-limit, zod; nodemon (dev).
- `server/.env.example`: PORT, NODE_ENV, MONGODB_URI, JWT_SECRET, JWT_EXPIRES_IN, CLIENT_URL, REQUIRE_E2EE.
- `src/config/env.js`: loads server/.env then repo-root .env; zod validation with clear exit message; normalizes unencoded credentials in MONGODB_URI in memory (warns).
- `src/config/db.js`: Mongoose connect with clear success/failure logging; retries with public DNS when SRV lookup fails (Windows link-local IPv6 DNS workaround).
- Models — `User` (unique lowercase username, `toPublicJSON` never exposes passwordHash/encryptedPrivateKey), `Conversation` (unique sparse directKey, groupKeys, members+lastMessageAt index), `Message` (delivery/read receipts, unique sender+clientId dedupe index, conversationId+createdAt index), plus `models/index.js` barrel.
- `src/app.js`: helmet, CORS restricted to CLIENT_URL, 100kb JSON limit, `GET /api/health`, 404 handler, central error handler with `{ error: { message, code } }`.
- `src/server.js`: HTTP server bootstrap + graceful shutdown (Socket.io attaches in a later phase).
- `src/utils`: `AppError`, `asyncHandler`.

**Verified**
- Boots via root `npm run start`; connects to MongoDB Atlas; `/api/health` returns `{"status":"ok"}`; unknown route returns 404 JSON; CORS allows only CLIENT_URL.
- Model smoke test: all indexes built; username lowercasing; duplicate username / duplicate sender+clientId / duplicate directKey rejected (E11000); sparse directKey allows multiple groups; all temp data removed.

**Known findings**
- Real MONGODB_URI: password contains an unencoded `@`; no database name in the path (driver defaults to db `test`). `env.js` normalizes the credentials in memory each boot (warning). Fixing the .env (`%40`, add `/chatwave`) is recommended — it was intentionally not touched.
- nodemon's transitive dev dependency `braces` has advisory GHSA-vfj7-8cjw-p6xm with no patched release; dev-only, accepted.

## Phase 2 — Auth & user API (2026-10-17)

**Added**
- `POST /api/auth/register` (zod-validated: username 3-20 `[A-Za-z0-9_]`, lowercased; displayName 1-40; password 8-72; optional E2EE keys that become required when `REQUIRE_E2EE=true`) → `201 { token, user }`, bcryptjs (10 rounds), random avatarColor, `409 USERNAME_TAKEN` on duplicates.
- `POST /api/auth/login` → `{ token, user, encryptedPrivateKey }`; identical `401 INVALID_CREDENTIALS` ("Invalid username or password") for wrong password and unknown user; updates `lastSeen`.
- `GET /api/auth/me` → `{ user, encryptedPrivateKey }`.
- `src/middleware/auth.js` — Bearer JWT → `req.user`; 401 codes `AUTH_REQUIRED` / `INVALID_TOKEN` / `TOKEN_EXPIRED`.
- `src/middleware/validate.js` (zod body validator), `src/middleware/rateLimit.js` (auth routes: 20 req / 15 min / IP, `429 RATE_LIMITED`).
- `GET /api/users/search?q=` — case-insensitive prefix on username/displayName, escaped regex, excludes self, limit 20, public fields only.
- `GET /api/users/:id` (400 invalid id / 404 unknown), `PATCH /api/users/me` (displayName, avatarColor).
- Utils `token.js`, `avatarColor.js`, `escapeRegex.js`; `User.toPublicProfileJSON()`.
- `server/tests/` — node:test suite (12 tests) + `npm test` (glob `tests/**/*.test.js`); test DB derived from MONGODB_URI as `<db>_test`, dropped before/after run with a non-test-database guard.

**Verified**
- `npm test`: 12/12 pass on Atlas `chatwave_test` (created + dropped). Covers register, validation, duplicate, login ok/fail, missing/invalid/expired token, me, search (incl. regex escaping), get-by-id, patch-me.
- Boot via root `npm run start`; `/api/health` 200; protected routes 401 without token; live rate limit check: 20×401 then `429 RATE_LIMITED`.
- `REQUIRE_E2EE=true` branch separately checked (keys required when enabled).

## Phase 3 — Client foundation (2026-10-17)

**Added** (`/client` — Vite + React 19, JavaScript, ES modules)
- Scaffolded with the create-vite `react` template, then pruned to the allowed packages: `react`, `react-dom`, `react-router-dom`, `socket.io-client` (+ `vite` and `@vitejs/plugin-react` as dev tooling). Template demo files, `@types/*`, oxlint and its config were removed; `dev` / `build` / `preview` scripts kept.
- `client/.env.example` — `VITE_API_URL=http://localhost:5000/api` and `VITE_SOCKET_URL=http://localhost:5000`. No real `.env` was created or touched.
- `src/styles/global.css` — design system: light/dark tokens on `[data-theme]` (+ `color-scheme`), teal/indigo brand, spacing / radius / shadow / type scales. Reusable classes: `.btn` (primary, ghost, danger, icon, sm/lg/block), `.input` (+ invalid, `.input-group` for the password reveal), `.field`, `.modal` (+ backdrop), `.avatar` (sm/md/lg), `.badge` (+ variants), `.toast`, `.skeleton` (+ text/circle/avatar), `.spinner`, chat bubbles (`.bubble--own` right/primary, `.bubble--other` left/neutral), empty state, 404 page, responsive rules below 768px, reduced-motion, focus rings.
- `src/services/api.js` — the single fetch wrapper: reads `VITE_API_URL`, attaches `Authorization: Bearer` from localStorage, parses `{ error: { message, code } }` into `ApiError`, maps network failures, and on a 401 (except `/auth/login` / `/auth/register`) clears the token, fires `chatwave:unauthorized` and redirects to `/login`.
- `src/context/AuthContext.jsx` + `src/hooks/useAuth.js` — exposes `{ user, token, loading, login, register, logout }`; token persisted under `chatwave.token`; session restored through `GET /api/auth/me` on refresh; mirrors API 401s into state.
- `src/context/ToastContext.jsx` + `src/hooks/useToast.js` + `components/Toast.jsx` — `showToast(message, type, { duration })` with success/error/info variants, auto-dismiss, manual dismiss, max 4 visible, aria `status`/`alert`.
- `components/`: `Avatar` (initials on the server `avatarColor`, luminance-aware text color, sm/md/lg), `BrandLogo` (teal→indigo mark), `FormField` (label + inline error/hint wired with `aria-describedby`), `EmptyState`, `FullPageSpinner`, `ThemeToggle`, `ProtectedRoute` / `PublicRoute` wrappers, inline SVG icon set (`icons.jsx`).
- `hooks/useTheme.js` — light/dark toggle stored as `chatwave.theme` in localStorage; the inline script in `index.html` applies it before first paint (no theme flash).
- `pages/`: `LoginPage` + `RegisterPage` (centered card; client validation mirrors the server zod rules with identical messages; blur validation; show/hide password toggle; submit spinner; server error banner; success toast; redirect back to the originally requested page), `ChatPage` (placeholder shell: sidebar + conversation panel, header with avatar/displayName/@username, theme toggle, logout, empty states), `NotFoundPage` (404).
- Routing (`App.jsx`): `PublicRoute` → `/login`, `/register`; `ProtectedRoute` → `/`; `*` → 404. Full-page spinner while the session is being restored.

**Verified**
- Root `npm run build` → vite build succeeds: 45 modules, `dist` ≈ 280 kB JS (88 kB gzip) + 18 kB CSS.
- Runtime smoke on the built app (`vite preview`): `GET /` 200 with ChatWave title, `#root`, theme bootstrap script; hashed JS + CSS assets served 200; SPA fallback (`/login`) serves `index.html` — 9/9 checks.
- Dev-server smoke (`vite dev`): `GET /` 200, `main.jsx` / `App.jsx` transform and serve, `global.css` serves both theme token sets — 5/5 checks.

**Fix — signup 404 (2026-10-17)**
- Symptom: `POST http://localhost:5173/api/auth/register` → 404 (the request never reached Express).
- Cause: `client/.env` did not exist, so `VITE_API_URL` was unset and `api.js` fell back to the relative `/api`, which the Vite dev server answers with 404.
- Fix: created `client/.env` (`VITE_API_URL=http://localhost:5000/api`, `VITE_SOCKET_URL=http://localhost:5000`, matches root `PORT=5000`); `api.js` now logs a dev-only console warning when `VITE_API_URL` is missing.
- Verified: CORS preflight `OPTIONS /api/auth/register` with `Origin: http://localhost:5173` → 204 + `Access-Control-Allow-Origin: http://localhost:5173` (POST/content-type allowed); rebuilt the client.

**Notes / assumptions**
- `client/.env` is gitignored (root `.gitignore`) and holds only local, non-secret values; `.env.example` stays the committed reference. If the server port ever changes, update `client/.env` to match.
- Bubble, modal and skeleton styles are defined but not yet exercised by this phase's screens — they are wired up in the chat phases.
- Browser-only behavior (theme toggle, toast timing, 401 redirect, localStorage) was not exercised in a real browser; it is covered by the manual checklist below.

## Phase 4 — Conversations & message API (2026-10-17)

**Added** (server — every route requires a Bearer token and checks membership)

- `POST /api/conversations/direct { userId }` — finds or creates the direct conversation via the unique `directKey` (sorted member ids); idempotent from either side, `201` when created / `200` when found; members populated (public fields only); blocks self (`400 SELF_CONVERSATION`), unknown user (`404 USER_NOT_FOUND`).
- `POST /api/conversations/group { name, memberIds, groupKeys? }` — creator becomes the only admin; name 1-50 chars (trimmed); 2-50 members besides the creator (creator may be redundantly listed; duplicates rejected; unknown ids → `400 UNKNOWN_MEMBERS`); `groupKeys` optional for now (encryption phase), each envelope must target members; `currentKeyVersion` = highest envelope version (default 1).
- `GET /api/conversations` — the caller's conversations sorted by `lastMessageAt` desc, members populated, `groupKeys` excluded by projection, plus a per-conversation `unreadCount` (messages from others not in the caller's `readBy`, deleted excluded) computed in one aggregation.
- `GET /api/conversations/:id` — members only (403 otherwise); includes `unreadCount` and only the caller's own `groupKeys` envelopes.
- `GET /api/conversations/:id/messages?before=&limit=` — cursor pagination (limit 1-100, default 30): newest first in the DB, returned oldest → newest; `before` accepts a message id (exact cursor, with `_id` tiebreaker for same-millisecond timestamps) or an ISO date; response `{ messages, hasMore, nextBefore }`; contents of `deletedForEveryone` messages are hidden (null ciphertext/iv).
- `POST /api/conversations/:id/messages` — REST fallback for the socket phase: zod-validated (`ciphertext` ≤ 8000 chars, `clientId` ≤ 64, `iv` required when encrypted); deduplicated by sender + clientId (`201` create, `200` with the original message on retry, `409 CLIENT_ID_REUSED` across conversations); updates `lastMessageAt` / `lastMessageId`.
- `DELETE /api/messages/:id` — sender only (`403 NOT_MESSAGE_SENDER`); sets `deletedForEveryone`, clears `ciphertext` (`''`) and `iv`; idempotent.
- `src/utils/messageService.js` — shared `createMessage({ conversation, senderId, payload })` (dedupe, conversation stamping, defensive validation, `REQUIRE_E2EE` gate → `400 ENCRYPTION_REQUIRED`) so the Socket.io layer reuses identical logic next phase.
- `src/utils/serialize.js` — plain-object serializers for hydrated and lean docs: users (public fields only), messages (deleted content hidden), conversations (own key envelopes only).
- `src/utils/directKey.js` — canonical sorted-id key builder.
- `src/middleware/validate.js` — new `validateQuery` (zod) storing into `req.validatedQuery` (Express 5 `req.query` is a getter).
- Index: `Message { conversationId, sender, 'readBy.user' }` for unread counts; `Conversation.name` now `maxlength: 50`.
- Tests: `tests/conversations.test.js` (9 tests) + `tests/messageService.e2ee.test.js` (2 tests) and a shared `tests/helpers/harness.js`; `npm test` now uses `--test-concurrency=1` so the files sharing `chatwave_test` run sequentially.

**Verified**
- `npm test`: 23/23 pass on Atlas `chatwave_test` (12 auth + 9 conversations + 2 E2EE gate) — direct conversation found-or-created (same id from both sides, single row), self/unknown/invalid rejection, group rules + admins + key envelopes, list order + per-user unread counts, non-member 403s (list/send/single), a 3-page cursor walk (id and ISO cursors, exact clientId sequences, `hasMore`/`nextBefore`), dedupe (`200` same id, one row, `409` on reuse), delete-for-everyone (sender-only, DB cleared, hidden in history, idempotent), payload/auth validation, REQUIRE_E2EE rejection + acceptance.
- Boot check: the running server (nodemon) reloaded the new code and connected to MongoDB; `/api/health` → 200; `/api/conversations` and `DELETE /api/messages/:id` → `401 AUTH_REQUIRED` (routers live, auth enforced).

**Notes / assumptions**
- Create endpoints answer `201` when a resource is created and `200` when an equivalent one already existed (direct conversation, deduplicated message).
- Read receipts are not written yet — `readBy`/`deliveredTo` stay empty until the Socket.io phase, so `unreadCount` counts every message from others unless `readBy` was set manually.
- `nextBefore` is a message id (exact cursor); ISO dates are also accepted for `before`.
- All list/history reads use `lean()` + explicit projections; message endpoints check membership through one shared helper.

## Phase 5 — Realtime layer: Socket.io (2026-10-17)

**Added** (server)

- `src/sockets/index.js` — `attachSockets(httpServer)` (called once from `server.js`): Socket.io with CORS limited to `CLIENT_URL`; an `io.use` handshake middleware that verifies the JWT from `handshake.auth.token`, stores `socket.data.userId` and rejects otherwise with `connect_error` carrying `err.data.code` (`AUTH_REQUIRED` / `INVALID_TOKEN` / `TOKEN_EXPIRED` / `AUTH_FAILED`, same messages as the REST middleware). `getIO()` exposes the instance to REST code and returns `null` when unattached (REST-only test runs stay green).
- `src/sockets/presence.js` — in-memory `Map<userId, Set<socketId>>` presence (several tabs = one online user). On the user's first socket: broadcast `presence:update { userId, online: true }` to everyone they share a conversation with; the new socket also joins the personal room `user:<id>` plus one `conv:<id>` room per conversation and receives `presence:snapshot { users: [{ userId, online }] }`. On the last socket disconnect: persist `lastSeen` and broadcast `presence:update { userId, online: false, lastSeen }`.
- `src/sockets/messages.js` — `message:send` (zod-validated, membership-checked, created through the shared `messageService`; marks the message delivered for every recipient currently online before emitting; broadcasts `message:new { message }` to the conv room; acks `{ ok: true, data: { message } }`; a retry with the same `clientId` acks the original message without re-broadcasting) and `message:delete { messageId }` (membership + sender-only; emits `message:deleted { conversationId, messageId }` to the room).
- `src/sockets/typing.js` — `typing:start` / `typing:stop` (zod-validated, membership-checked): broadcast `typing { conversationId, userId, isTyping }` to the other members of the room only (the sender's own sockets are excluded); repeated states are no-ops and events are throttled to 40 per 10 s per socket.
- `src/sockets/conversations.js` — `announceConversationCreated(conversation)`: every member's sockets join `conv:<id>` and receive `conversation:new { conversation }` (serialized per member, with that member's own group key envelopes). Called by the REST create endpoints on actual creation (finding an existing direct conversation does not notify).
- `src/sockets/rooms.js`, `src/sockets/rateLimit.js`, `src/sockets/helpers.js` — room-name helpers, sliding-window limiter, zod→AppError payload parsing and the `{ ok, data | error }` ack helpers.
- `src/utils/conversationAccess.js` — `loadConversationForMember` + `OBJECT_ID_RE` extracted from the conversation controller so REST and sockets share the exact same 400/404/403 membership checks.
- `src/utils/messageService.js` — new shared `deleteMessageForEveryone({ message, userId })`, used by both `DELETE /api/messages/:id` and the `message:delete` socket event.
- `src/server.js` — attaches Socket.io to the HTTP server before `listen`; graceful shutdown closes sockets first.
- Tests: `tests/sockets.test.js` (9 integration tests using `socket.io-client`) — auth rejections, presence snapshot/updates/offline+`lastSeen`, `message:send` delivery + ack + delivered marking, payload/membership validation, typing relay + self-exclusion, `message:delete` broadcast, `conversation:new` + room join, per-socket rate limiting. `socket.io-client` was added as a **dev-only** dependency of the server to drive the tests (the same package is already allowed for the client).

**Verified**
- `npm test`: 32/32 pass on Atlas `chatwave_test` (12 auth + 9 conversations + 2 E2EE gate + 9 sockets).
- Live boot: the running server (nodemon) reloaded with Socket.io attached — `/api/health` → 200 and a real socket client without a token is rejected with `connect_error` "Authentication required" / `AUTH_REQUIRED`.
- `npm audit --omit=dev`: 0 vulnerabilities (the 3 high advisories are the pre-existing dev-only nodemon → chokidar → braces chain).

**Notes / assumptions**
- `message:new` uses `{ message }` (same shape as REST) and `conversation:new` uses `{ conversation }`, serialized per recipient.
- Presence broadcasts go to `user:<id>` rooms; a user with several tabs gets one event per connected socket.
- The presence registry is single-process, in memory (noted in the file) — a shared store/Redis adapter is the horizontal-scaling path.
- Delivered marking is presence-based (recipient connected at send time), not client-acknowledged; read receipts remain for a later phase.
- Per-socket rate limits reset when the socket reconnects (new handshake = new limiter).
- Socket-side conversation creation reuses `announceConversationCreated`; no `conversation:create` event exists yet (REST creates conversations today).

## Phase 6 — Chat interface (2026-10-17)

**Realtime plumbing (client)**
- `src/services/socket.js` — the only place socket code lives: `createSocket(token)` (`auth: { token }`, `autoConnect: false`, infinite reconnection with backoff), `connectSocket`/`disconnectSocket`, `emitWithAck()` (resolves the ack's `data`, rejects with `SocketError { message, code }` on `{ ok: false }`, timeout or offline) and the typed emits `sendMessage`, `deleteMessage`, `startTyping`, `stopTyping`.
- `src/context/SocketContext.jsx` + `src/hooks/useSocket.js` — connects only while logged in, reports `status` ("connecting" | "connected" | "disconnected"), counts successful connects (`connectionCount`), disconnects and drops listeners on logout, and mirrors handshake auth failures (`TOKEN_EXPIRED` / `INVALID_TOKEN` / `AUTH_REQUIRED`) into the same session-expiry path a REST 401 uses.
- `src/context/ChatContext.jsx` + `src/hooks/useChat.js` — conversations (sorted, `unreadCount`), messages per conversation, presence map, typing map and the active conversation, plus `refreshConversations`, `selectConversation`, `reloadConversation`, `loadOlderMessages`, `sendMessage`, `retryMessage`, `deleteMessage`, `notifyTyping`/`stopTyping`, `startDirectConversation`. Wires `message:new`, `message:deleted`, `conversation:new`, `presence:update`, `presence:snapshot` and `typing`; refetches conversations + the open conversation's latest page after a reconnect; received typing flags self-clear after 6 s.
- `src/services/api.js` — `usersApi.search` + `conversationsApi.{list,get,messages,startDirect,createGroup}` (all HTTP stays here).

**UI**
- `Sidebar` + `ConversationList` + `UserSearchResults`: avatar with an online dot, direct chats titled by the other member, group name, last-message time, unread badge, "typing…" hint, 300 ms-debounced user search that starts/reopens the direct chat on click, a "New group" button (toast placeholder — group UI is a later phase), skeleton loading, empty and error-with-retry states, plus the signed-in user + logout in the footer.
- `ChatWindow` + `ChatHeader` + `MessageList` + `MessageBubble` + `MessageComposer`: header with avatar/name and "online" / "last seen …" / "N members" / "Alex is typing…"; day separators; 5-minute bubble grouping with timestamps, sender names and avatars; hover "delete for everyone" action on own messages with a confirm modal; infinite scroll upwards that preserves the scroll position; auto-scroll when near the bottom, otherwise an "N new messages" pill; composer with an auto-growing textarea (Enter sends, Shift+Enter breaks the line), 2000-character counter and inline validation.
- `ConfirmDialog`, `ConnectionBanner` (connecting/offline states) and a `data-view` switch for the mobile layout: below 768px exactly one pane is shown, with a back button in the chat header.
- `Avatar` accepts an optional `color` (group avatars); `icons.jsx` gained send/plus/trash/back/down/refresh/users/wifi-off/clock icons; `utils/{id,time,conversations}.js` hold `createClientId` (randomUUID + getRandomValues fallback), date/time formatting and conversation display helpers.

**Sending (optimistic)**
- `crypto.randomUUID()` clientId, bubble appears immediately as "sending" (clock icon), `message:send` ack → "sent" (check icon), ack failure/timeout/offline → "failed" with an inline Retry that re-emits the same clientId (server-side dedupe). Plaintext phase: `ciphertext` = text, `iv: ''`, `keyVersion: 1`, `encrypted: false`.
- Server compatibility: the `iv` field in the socket `message:send` schema and the REST create-message schema no longer requires `min(1)` characters — an empty `iv` is accepted while `encrypted` is false, and the existing `superRefine` still rejects an empty/missing iv when `encrypted` is true.

**Tests**
- `server/tests/clientPlaintext.test.js` (3 tests) pins the client contract: plaintext + `iv: ''` is accepted, stored verbatim, broadcast, deduplicated on retry and returned by history; an empty iv with `encrypted: true` is still `VALIDATION_ERROR`; the REST fallback accepts the same shape.

**Verified**
- `npm run build` (root) → vite build succeeds: 93 modules, `dist` 355.9 kB JS (110.7 kB gzip) + 30 kB CSS.
- `npm test` (server) → 35/35 pass on Atlas `chatwave_test` (12 auth + 3 plaintext contract + 9 conversations + 2 E2EE gate + 9 sockets).
- Live smoke against the running API on `:5000` (throwaway users, cleaned up afterwards): 15/15 checks — both sockets authenticate by handshake JWT, presence snapshot/update, `message:send` with `iv: ''` acked and broadcast, stored shape keeps `encrypted:false`, typing start/stop relayed, `unreadCount` 1 for the recipient, history returns the plaintext message, `message:delete` broadcast and hidden from history.
- Boot: `npm run start` → MongoDB connected + Socket.io attached; `/api/health` 200. Client dev server (Vite, `:5173`) serves `/` (200) and transforms all 24 new/changed modules without errors.

**Notes / assumptions**
- Read receipts are still a later phase: opening a conversation clears the unread badge locally, received messages are not written to `readBy` and the "sent" check icon does not turn into "read".
- The composer caps messages at 2000 characters (the server accepts up to 8000); the counter warns from 90 % and blocks sending above the limit.
- Encrypted messages arriving from another client render as a "🔒 Encrypted message" placeholder until the decryption phase.
- Browser-only behaviour (scroll anchoring, hover actions, mobile pane switching, connection banner timing) could not be executed in a real browser here — it is covered by the manual checklist in the phase report.

## Phase 7 — Delivery & read receipts, accurate unread (2026-10-17)

**Server**
- `src/utils/receiptService.js` (new) — the single place `deliveredTo` / `readBy` rows are written: `deliverPendingMessagesForUser` (connect-time catch-up, capped at 500 per connect, oldest first), `markMessagesDelivered` (explicit `message:delivered`, optionally limited to given message ids) and `markMessagesReadUpTo` (bulk "everything from others at/before the read point", with an `_id` tiebreaker for same-millisecond messages). A read implies delivered: the read pass first fills in missing `deliveredTo` rows; the receipt conditions live inside the `updateMany` filters, so concurrent duplicate events cannot push twice. Own and deleted-for-everyone messages are skipped everywhere.
- `src/sockets/receipts.js` (new) — `message:delivered { conversationId, messageIds? }` (membership-checked, 200 ids max, acked `{ delivered: n }`) and `message:read { conversationId, upToMessageId }` (validates that the read point belongs to the conversation; acked `{ readCount, deliveredCount, at }`). Delivery updates emit one `message:status { conversationId, messageId, deliveredTo, readBy }` per message to the conversation room; reads emit one batched `messages:read { conversationId, userId, upToMessageId, upToMessageAt, at, readCount, deliveredCount }` (per-message events would be a storm after a long absence). Rate-limited (60 events / 10 s per socket).
- Connect-time delivery catch-up: after the presence handshake joins the conversation rooms, `deliverPendingMessages(io, userId)` marks every undelivered message addressed to the connecting user as delivered and notifies the rooms, so sender ticks turn "delivered" without the sender being online. Failures are logged and never break the handshake.
- `src/utils/serialize.js` gained `serializeMessageStatus`; `src/models/Message.js` gained the `{ conversationId: 1, 'deliveredTo.user': 1 }` index.
- Unread counts in `GET /api/conversations` (list) and `GET /api/conversations/:id` now share one `unreadMessagesFilter(userId, { conversationId })` helper in `src/utils/messageService.js` — the exact mirror of what the read path writes, so counts can never drift.

**Client**
- `src/services/socket.js` — `sendMessageDelivered` / `sendMessageRead` (acked, 5 s timeout).
- `src/context/ChatContext.jsx` — receipts state (`deliveredTo` / `readBy` kept on every message), handlers for `message:status` and `messages:read`, a debounced `message:delivered` batch (300 ms) for every incoming message, and an optimistic receipt write on a successful read ack.
- Read receipts: emits `message:read` only while the conversation is open AND the tab is visible (Page Visibility API) AND the list is scrolled near the bottom (debounced 400 ms, re-armed by new messages, idempotent on reconnect). A hidden tab no longer counts messages in its open conversation as seen — the sidebar badge keeps growing until the user looks. Reads clear the badge optimistically; `messages:read` from another device clears it too.
- The browser tab title shows the total unread count ("(3) ChatWave", capped at "99+").
- `src/utils/receipts.js` (new) — tick state (one grey = sent, two grey = delivered, two blue = read; in groups delivered/read only when ALL other members have it) and per-member details for the info view. `src/components/MessageBubble.jsx` renders the ticks as a button (title = "Seen by N of M" / "Delivered to …"), `src/components/MessageInfoDialog.jsx` (new) lists who delivered and who read with exact times (opened from the ticks). `MessageList` reports its scroll position (`onBottomChange`) and passes receipt props; `ChatWindow` hosts the dialog.
- `src/utils/time.js` gained `formatDateTime`; `icons.jsx` gained single/double tick icons; `global.css` gained the blue read-tick token (`--color-receipt-read`, light + dark), tick button styles and the message-info dialog styles.

**Tests**
- `server/tests/receipts.test.js` (6 tests, node:test): connect-time catch-up marks pending messages delivered and emits `message:status` to the room; `message:delivered` marks specific messages, is idempotent and notifies the room; `message:read` marks everything up to the point (including a read-implies-delivered case with a "lost" delivery mark); unread counts follow the read point in `GET /api/conversations` (2 → read one → 1); non-members, unknown ids, foreign read points and invalid payloads are rejected; in a group one member's read leaves the others unread.

**Verified**
- `npm test` (server) → 41/41 pass on Atlas `chatwave_test` (12 auth + 3 plaintext contract + 9 conversations + 2 E2EE gate + 9 sockets + 6 receipts).
- `npm run build` (root) → vite build succeeds: 95 modules, `dist` 363.4 kB JS (112.8 kB gzip) + 31.4 kB CSS.
- Live smoke against the running API on `:5000` (throwaway users, cleaned up afterwards): 14/14 checks — send while the recipient is offline (nothing delivered, REST unread 2), connect-time catch-up emits `message:status` for both messages, `message:read` acks `readCount: 2` and emits `messages:read`, the DB holds delivered+read rows, REST unread drops to 0, history exposes `readBy`, and a repeated `message:delivered` is idempotent (`delivered: 0`).
- Tick rules sanity-checked against `client/src/utils/receipts.js` (direct + group: partial delivery stays "sent", partially read stays "delivered", only all-member read turns blue; labels and per-member details).
- Boot: `npm run start` → MongoDB connected + Socket.io attached. Client dev server transforms all changed modules (ChatContext, MessageList, MessageBubble, MessageInfoDialog, ChatWindow, receipts.js, time.js, socket.js, icons.jsx) with 200.

**Notes / assumptions**
- "Delivered" has two paths: presence-based marking at send time (online members) plus the client's `message:delivered` batch; the connect-time catch-up covers a recipient who was offline. Duplicates are idempotent.
- The catch-up marks at most 500 messages per connect (oldest first) — a longer backlog advances on the next connect. Noted in `receiptService.js`.
- Deleting for everyone skips receipts (invisible) — deleted messages therefore never flip ticks.
- Browser-only behaviour (tick rendering in the real DOM, visibility/scroll gating, tab-title updates, the info dialog) could not be executed in a real browser here — it is covered by the manual checklist in the phase report.

## Phase 8 — Group chat: members, admins, system messages (2026-10-17)

**Server**
- `POST /api/conversations/:id/members` (admin only) adds members (`UNKNOWN_MEMBERS` for bad ids, `GROUP_FULL` above 50); `DELETE /api/conversations/:id/members/:userId` (admin, or self = leave); `PATCH /api/conversations/:id` (admin) renames; `POST /api/conversations/:id/admins` (admin) promotes. All return the updated `{ conversation }` except self-leave → `{ conversationId, left: true }`.
- Admin invariant: a group always keeps at least one admin — when the last admin removes themselves, the earliest remaining member is promoted automatically with a system message. Removing the last remaining member deletes the conversation and all of its messages.
- System messages: `Message.type` (`'user' | 'system'`, default `'user'`) plus `createSystemMessage` (plain text in `ciphertext`, `iv: null`, `encrypted: false`, `clientId: 'system:<uuid>'`); they update `lastMessageAt/lastMessageId` so the sidebar reorders but are excluded from unread counts and receipt writes, and `message:delete` rejects them with `SYSTEM_MESSAGE` (403). Texts: "X added A, B", "X left", "X removed Y", "X renamed the group to “N”", "X made Y an admin", "X is now an admin".
- `src/sockets/conversations.js` rewritten around single-purpose announcers: `announceConversationUpdated` (room), `announceConversationToMember` (personalized `conversation:new` + sockets join the room), `announceConversationRemoved` (personalized `conversation:removed` + sockets leave), `announceNewMessage` and `announcePresenceForNewMembers` (room gets `presence:update`, newcomers get a `presence:snapshot`). All are no-ops without a Socket.io server (REST-only test runs). Emission order for adds: `conversation:updated` → join + `conversation:new` → presence → system-message `message:new`.
- `serializeConversation` now only includes `unreadCount` when explicitly passed, so `conversation:updated` broadcasts never reset a recipient's badge; `groupKeys` are still only sent personally via `conversation:new`. `conversationAccess.js` gained `assertGroupConversation` / `assertGroupAdmin` / `isGroupAdmin` (membership 403 is still checked first).

**Client**
- `src/components/NewGroupDialog.jsx` (new) — "New group" builder: name validation (1–50 chars), debounced user search (300 ms) with multi-select chips, loading/empty/error states, requires 2 members besides the creator, creates via `startGroupConversation` and opens the group.
- `src/components/GroupInfoPanel.jsx` (new) — slide-over from the chat header: avatar + rename (admin), N members, member list with online dots, admin badges, and admin-only promote/remove actions; "Add members" search excludes current members; "Leave group" behind a confirm dialog. Non-admins see a read-only member list.
- Group rendering: system messages render as centered grey pills in `MessageList` (and break bubble grouping); in groups each sender block shows the sender's name colored with their `avatarColor`; the header shows `N members` and the new group-info button; typing labels are "Alex is typing…", "Alex and Sam are typing…" or "Several people are typing…".
- Being removed from a group while viewing it closes the conversation, drops it from the list and shows a dismissible sidebar notice ("You are no longer a member of “X”"). A voluntary leave (`left: true`) skips the notice.
- `ChatContext` gained `removedNotice`/`dismissRemovedNotice`, `startGroupConversation`, `addGroupMembers`, `removeGroupMember`, `renameGroup`, `promoteGroupAdmin`, `leaveGroup`, `dropConversation`, and `conversation:updated` / `conversation:removed` socket handlers; system messages never bump unread counts, never enter the delivery queue and never gate read receipts. `conversationsApi` gained the four group endpoints; `utils/conversations.js` gained `isGroupAdmin`; `icons.jsx` gained `UsersIcon`, `UserPlusIcon`, `PencilIcon`.

**Tests**
- `server/tests/groups.test.js` (5 tests, node:test): non-admin cannot add members (403 `NOT_GROUP_ADMIN`) while the admin's add returns the updated conversation, emits `conversation:updated` to the room and a personalized `conversation:new` to the newcomer, stores the "X added Y" system message, and leaves the newcomer's unread count at 0; rename + promote are admin-only and idempotent (double promote adds no second system message); leaving as the last admin promotes the earliest remaining member ("X is now an admin"); a removed member stops receiving `message:new`, cannot send (403) and no longer sees the conversation; the last member leaving deletes the conversation and its messages.

**Verified**
- `npm test` (server) → 46/46 pass on Atlas `chatwave_test` (12 auth + 3 plaintext contract + 9 conversations + 2 E2EE gate + 9 sockets + 6 receipts + 5 groups).
- `npm run build` (root) → vite build succeeds: 97 modules, `dist` 382.65 kB JS (116.08 kB gzip) + 36.97 kB CSS.
- Live smoke against the running API on `:5000` (throwaway users, cleaned up afterwards): create group 201, non-admin add → 403 `NOT_GROUP_ADMIN`, admin rename 200, the system message "Smoke Alice renamed the group to “Smoke Crew 2”" is stored and returned by history, self-leave → 200 `{ left: true }`, the leaver gets 403 `NOT_A_MEMBER` afterwards and the member list no longer contains them.
- Boot: `npm run start` → MongoDB connected (db=test) + Socket.io attached; `/api/health` 200; `POST /api/conversations/:id/members` without a token → 401.

**Notes / assumptions**
- The "New group" UI requires 2 members besides the creator, matching the server's `MIN_GROUP_MEMBERS` (the create-group contract was pinned by earlier tests).
- `conversation:updated` intentionally carries no `unreadCount`/`groupKeys`, so whole-room broadcasts cannot reset badges or leak wrapped keys; personalized payloads only go through `conversation:new`.
- Re-adding an existing member and promoting an existing admin are no-ops (no duplicate system message).
- Groups are still plaintext until the E2EE phase; system messages contain no secrets by design and are stored as plain text.
- Browser-only behaviour (the new-group dialog, slide-over panel, system-message styling, removal notice) could not be executed in a real browser here — it is covered by the manual checklist in the phase report.

## Phase 9 — End-to-end encryption (2026-10-17)

**Client crypto module** (`client/src/utils/crypto/`, pure functions, Web Crypto API only — no crypto libraries)
- `base64.js` (bytes/base64/UTF-8/random helpers), `jwk.js` (parse, strip advisory fields, canonical key form), `keys.js` (`generateKeyPair` ECDH P-256, `exportPublicKey` JWK string, private/public import — working private key is non-extractable).
- `password.js` — `encryptPrivateKeyWithPassword` / `decryptPrivateKeyWithPassword`: PBKDF2-SHA256, 310 000 iterations, random 16-byte salt → AES-GCM-256, random 12-byte IV; `{ ciphertext, iv, salt, iterations }` as base64.
- `sharedKey.js` — `deriveSharedKey` (ECDH `deriveKey` → AES-GCM-256, non-extractable). `messageCrypto.js` — `encryptMessage` (fresh 12-byte IV per message, UTF-8) and `decryptMessage` (returns "Unable to decrypt this message" instead of throwing).
- `groupCrypto.js` — `createGroupKey`, `wrapGroupKeyForMember`, `unwrapGroupKey`; `fingerprint.js` — `keyFingerprint` (SHA-256 of both public keys, sorted, grouped hex) and `fingerprintOf` for the group view.
- `keyStore.js` — non-extractable private `CryptoKey` in IndexedDB, cleared on logout. `conversationCrypto.js` — in-memory caches (derived direct key per conversation, unwrapped group key per conversation+version, decrypted plaintext) and `encryptForConversation` / `decryptForConversation`.

**Client integration**
- Registration generates the key pair in the browser and sends `publicKey` + `encryptedPrivateKey`. Login restores the stored key, or decrypts the backup from the login response with the typed password and stores it. A session without a local key (new device, cleared site data) shows `UnlockScreen` to restore the key from the server backup. Accounts created before E2EE get keys at their next login (one-time `PATCH /api/users/me`, write-once).
- Every send path encrypts first (`encrypted: true`, correct `keyVersion`); there is no plaintext fallback — with no key the bubble fails and the composer is disabled. Bubbles, history and the sidebar preview decrypt on the client via `useDecryptedText`.
- Groups: the creator generates the key and wraps it for every member including themselves; adding members wraps every version the admin holds; on remove/leave a remaining admin's client creates the next version and `POST`s it (409 `STALE_KEY_VERSION` losers just adopt the winner's key through `conversation:keys`).
- Chat header shows a lock icon with "Messages are end-to-end encrypted" and opens the "Verify encryption" dialog (pair fingerprint for direct chats, per-member fingerprints for groups).

**Server**
- `publicKey` / `encryptedPrivateKey` are required at registration when `REQUIRE_E2EE=true`; shape-validated with zod (ECDH P-256 JWK string; base64 `ciphertext`/`iv`/`salt`, `iterations` 100 000–1 000 000). `encryptedPrivateKey` is only ever returned to its owner (login, `/auth/me`).
- `POST /api/conversations/:id/keys { baseVersion, groupKeys }` (admin only): increments `currentKeyVersion` with a compare-and-swap, requires exactly one envelope per current member at the new version wrapped by the acting admin; the server broadcasts `conversation:keys` (each member's own envelope only) and requests a rotation from the admins after a removal/leave.
- `addMembers` enforces envelopes for every existing key version; with `REQUIRE_E2EE=true`, plaintext messages are rejected with `ENCRYPTION_REQUIRED` on REST and sockets (system messages are exempt).
- `README.md` — new root file with a short, honest **Security** section (what is protected; password-wrapped backup is brute-forceable by a malicious operator; metadata not hidden; removed members keep what they already received; plus key-substitution and no-forward-secrecy caveats).

**Tests**
- `client/tests/crypto.test.js` (14 tests, `npm test` in `/client`): encrypt/decrypt round trip, fresh IV per message, wrong key / truncated IV → placeholder, ECDH both sides derive the same key, third party cannot decrypt, group key wrap/unwrap (and outsider fails), password backup round trip, wrong password fails, backups differ per call, fingerprint symmetry/determinism.
- `server/tests/e2eeRequired.test.js` (6 tests, `REQUIRE_E2EE=true`): keys required and shape-validated at registration, backup returned only to its owner, plaintext rejected on REST and sockets (nothing stored), encrypted accepted, group add/rotate protocol and plaintext system messages.
- `server/tests/conversations.test.js`: fixed `addMembers requires every existing version` — it tried to "add" a user who was already a member, so the server rightly rejected it for a different reason; it now registers a real newcomer.

**Verified**
- Client `npm test` → 14/14. Server `npm test` → 55/55 on Atlas `chatwave_test` (49 existing + 6 new). Client `npm run build` → 111 modules, 404 kB JS (122 kB gzip) + 39 kB CSS.
- Live end-to-end smoke (throwaway script, since deleted) with the real client crypto against the real Express app on `REQUIRE_E2EE=true`: register with keys → login on a "new device" and restore the key from the backup (the restored key is non-extractable) → direct message the server never sees in clear and the partner decrypts from history → group created with wrapped v1 keys → member removed → admin rotates to v2 → new message uses `keyVersion` 2 → history decrypts across both versions; the removed member gets 403.
- Boot: `node src/server.js` (PORT 5055, because 5000 was already in use) → MongoDB connected, Socket.io attached, `/api/health` 200, `/api/conversations` without token 401.

**Notes / assumptions**
- `REQUIRE_E2EE` stays `false` in the existing `.env` (the server still accepts plaintext for legacy data); set it to `true` to enforce. The UI always encrypts regardless.
- Messages and group envelopes created before this phase (plaintext, `encrypted: false`) still render as-is.
- The server cannot verify group-key cryptography; it enforces the protocol (membership, versions, envelope coverage) only.
- `server/package.json` lists `socket.io-client` as a devDependency (used by the socket tests since an earlier phase); it is outside the AGENTS.md allow-list for `server` and can be moved if you want it strict.
- IndexedDB persistence, the unlock screen, the lock chip and the verify dialog could not be exercised in a real browser here — see the manual checklist in the phase report.

**Fix — receiver sees "Unable to decrypt this message" (2026-10-17)**
- Symptom: the sender's message goes through, the receiver's bubble shows the placeholder.
- Cause 1 (stale member keys): a receiver's cached conversation had `members[].publicKey = null` for the sender — accounts created before E2EE only publish their key at their next login, after the receiver's list was already loaded. Without the sender's public key the receiver cannot derive the chat key, and nothing ever refetched the conversation. (The dev database confirms this setup: `admin` and `test` predate E2EE.)
- Cause 2 (unverified stored key): the IndexedDB key was trusted blindly, so a key that does not belong to the account's published public key failed silently forever; and after equipping a legacy account at login the in-memory user kept `publicKey: null`.
- Fix: `ChatContext.refreshConversationKeys` (throttled per conversation, 10 s) refetches a conversation when an encrypted message arrives from a member whose key is unknown, when a bubble/preview fails to decrypt (the fresh conversation re-runs decryption), and when a send fails for lack of a key. The stored key record is now bound to the account's public key (`keyStore.js`); a missing or mismatching binding forces a one-time password unlock that restores the key from the backup, which is checked against the published public key. `login()` now updates the user after equipping a legacy account.
- Tests: 2 new crypto tests (private/public canonical binding; a conversation cached without the partner key recovers after refetch). `npm test` (client) 16/16, build OK.
- Not verified in a real browser. Side effect: devices that already hold a stored key (written before this fix) ask for the password once to re-bind it.

**Fix — the actual "Unable to decrypt this message" root cause, and dropped group keys (2026-10-18)**
- Root cause (all received direct + group messages): the server→UI normalizer inside `ChatContext` (and `ConversationList.lastMessageOf`) rebuilt each message WITHOUT `ciphertext`/`iv`. The display layer (`useDecryptedText` → `decryptForConversation` → `decryptMessage`) therefore always received an empty envelope and returned the placeholder — for every received message, in both directions. The sender's own bubble looked fine only because its plaintext was served from the in-memory plaintext cache. The previous "stale member key" fix addressed a different, real path and did not cover this.
- Fix 1: normalization moved to a new React-free module `client/src/utils/messages.js` (`fromServerMessage`) — ONE canonical UI shape that KEEPS `ciphertext` + `iv` (nulled only for `deletedForEveryone` rows). `ChatContext` and `ConversationList` now both use it.
- Fix 2 (group add-member): `client/src/services/api.js` defined `conversationsApi.addMembers` TWICE; the second definition (no `groupKeys`) silently overrode the first, so wrapped group keys never left the browser — new members stayed keyless for v1 and a `REQUIRE_E2EE` server rejects the call as `INCOMPLETE_KEYS`. The duplicate was deleted.
- Diagnostics: `decryptMessage` now reports a dev-only, once-per-reason `console.warn` (`DECRYPTION_FAILURE` + `warnDecryptionFailure()`, also used for the "no key" path) — reason only, never keys/ciphertext/plaintext.
- Dead code removed: `isEcdhPublicJwk` (exported, never used). `api.js` now guards its `import.meta.env` reads, so the HTTP contract is unit-testable in Node.
- Regression tests (real app functions, JSON round-tripped payloads — `client/tests/crypto.test.js`): A→B, B→A, sender's own row, sidebar `lastMessage` preview, and group v1/v2 keys incl. self-unwrap all fail before the fix (`ciphertext: undefined` → placeholder) and pass after it. New `client/tests/api.test.js` pins the `addMembers`/`rotateKeys` request bodies.
- Verified: client `npm test` 24/24 (21 crypto + 3 API), server `npm test` 55/55, client `npm run build` OK (112 modules, 405.72 kB JS / 122.96 kB gzip); the built bundle contains the real `VITE_*` URLs (no leftover `import.meta.env` for our modules). Browser flows still need the two-browser manual checklist.

## Phase 10 — Polish, security & robustness pass (2026-10-18)

**Server — observability & shutdown**
- `src/utils/logger.js` (new) — the only logging entry point: JSON lines in production, human-readable in development, `warn`/`error` include stacks only outside production, and the serializer redacts anything matching `pass|token|secret|authoriz|cookie|jwt|ciphertext|wrappedkey|privatekey|iv|salt`. Message content is never logged anywhere.
- `src/app.js` — one request log line per API call (method, path *without* query string, status, duration; `/api/health` skipped) and a new `apiLimiter` (300 req/min per IP, disabled under `NODE_ENV=test`) next to the stricter auth limiter.
- Error handler normalizes parser/framework errors into the shared shape and never leaks internals in production: malformed JSON → `400 VALIDATION_ERROR`, oversized body → `413 PAYLOAD_TOO_LARGE`, malformed ObjectId → `400 VALIDATION_ERROR`, duplicate key → `409 DUPLICATE_KEY`; unexpected errors answer a generic message with `INTERNAL_ERROR`.
- `src/server.js` — graceful shutdown fixed and reordered: stop the presence heartbeat → flush `lastSeen` for everyone still online → `io.close()` (which also closes the HTTP server) → close MongoDB → let the event loop drain. The previous `process.exit(0)` aborted mid-teardown and killed the process with a libuv `UV_HANDLE_CLOSING ... async.c` assertion on Windows; the shutdown now sets `process.exitCode` instead (verified: `shutdown complete`, exit 0). A failed `listen` (e.g. `EADDRINUSE`) is now one clear log line + exit 1 instead of an unhandled `error` event with a raw stack trace.
- `src/config/env.js` — warns when `MONGODB_URI` has no database name (the driver would silently fall back to a database named `test`).
- `src/config/db.js`, `src/sockets/{presence,helpers,index}.js` — boot/connection/presence logs go through the logger; presence gained `flushPresence`, heartbeat start/stop and an idempotent disconnect so a crashed or duplicate socket can no longer leave a user "online" forever.

**Server — authorization & input limits**
- `DELETE /api/messages/:id` now checks conversation membership *before* the sender check: a member who was removed from a group can no longer delete messages in it (the group-independent path was verified).
- Group-key envelopes are length-capped (`wrappedKey` ≤ 2000, `iv` ≤ 64, request arrays ≤ 100 / 300 / 100 for create / addMembers / rotateKeys) and the same `maxlength` guards sit on the Mongoose schemas; the 100 kB JSON body limit remains the outer bound.
- `Message` history index widened to `{ conversationId: 1, createdAt: -1, _id: -1 }` so the cursor pagination sort is fully covered.
- `server/tests/security.test.js` (new, 8 tests): removed-member delete blocked, other conversations unaffected, no `passwordHash` / foreign `encryptedPrivateKey` in conversation, user-search or `/auth/me` responses, malformed JSON, oversized body, key-envelope limits, health + unknown-route shapes.

**Client — performance**
- `MessageList` renders a window of the newest 80 timeline items (date separators included) and appends 60 more when the user scrolls to the top or presses "Show earlier messages"; the server is only asked for another history page once the window covers everything in memory, and prepends keep the reading position via scroll-height anchoring. The first visible bubble of a cut window is de-grouped and its day separator is re-added.
- `MessageList` and `MessageBubble` are memoized; `ChatWindow` passes a stable `useCallback` retry handler, so a typing indicator, an unread badge or a composer keystroke no longer re-renders the whole list.
- New bubbles ease in (`bubble--enter` on the one message that arrived live — history pages and conversation switches stay still).
- Composer: a `valueRef`/`justSentRef` guard stops a second Enter or a double click from re-sending the same text with a fresh `clientId`; a stray Enter right after sending no longer shows a validation error.

**Client — UX, accessibility & robustness**
- Per-conversation mute: bell button in the chat header (`aria-pressed`, unmute/mute label + tooltip), stored under `chatwave.mutedConversations`; a muted conversation never raises a desktop notification.
- Opt-in desktop notifications: "Enable notifications" in the sidebar footer appears only while permission is `default`, so the browser prompt always follows an explicit click. Notifications are limited to a hidden tab, a non-open conversation and a non-muted conversation, and carry only the sender's display name + "New message" — never text. Clicking one focuses the window and opens that conversation.
- `utils/title.js` + `hooks/usePageTitle.js` own `document.title` (page name + `(n)` unread prefix, "99+" cap) so the chat layer and the pages can no longer overwrite each other.
- Contrast: `--color-text-faint` raised to `#5f6f85` (light) / `#8194ad` (dark) so faint text, hints, timestamps and placeholders reach WCAG AA (≥ 4.5:1) on every surface in both themes.
- Responsive: the chat header now flexes its title block (`flex: 1 1 auto`, ellipsis) and tightens gaps/icon buttons under 767px, with a dedicated ≤ 479px pass (smaller avatar/paddings) so 360px still fits the bell + verify chip + group info; `index.html` adds `interactive-widget=resizes-content` so the on-screen keyboard shrinks the layout instead of burying the composer.
- Dead code removed: `resetPageTitle` (`utils/title.js`), `hasErrors` (`utils/validation.js`); `SocketContext` now tears the session socket down through `disconnectSocket()` (drops every listener) instead of re-implementing it.

**Verified**
- Server `npm test`: **63/63 pass** on Atlas `chatwave_test` (12 auth + 3 plaintext contract + 12 conversations + 6 E2EE enforcement + 2 message-service E2EE + 6 receipts + 5 groups + 8 security + 9 sockets/presence).
- Client `npm test`: **24/24 pass**; `npm run build`: 115 modules, 411.75 kB JS (124.82 kB gzip) + 40.09 kB CSS, **no warnings**.
- Boot + shutdown smoke (temporary script, since deleted) on `PORT=5001` (5000 was occupied by the running dev server): MongoDB connected, `ChatWave API listening`, `/api/health` → `200 {"status":"ok"}`, unknown route → `404 NOT_FOUND`, oversized body → `413 PAYLOAD_TOO_LARGE`, then `SIGTERM` → `received SIGTERM - shutting down gracefully` → `shutdown complete`, **exit code 0** with no libuv assertion. The same script against the occupied port produced exactly one log line (`port 5000 is already in use - is another ChatWave server still running?`) and exit 1.

**Notes / assumptions**
- The old `Message` index from earlier phases is still present in existing databases; Mongoose creates the new one on boot but never drops the old. Dropping `{ conversationId: 1, createdAt: -1 }` manually is optional (it is now redundant, not harmful).
- Root `.env` still has no database name (the app therefore writes to MongoDB's default `test` DB) and an unencoded `@` in the password; both now print a boot-time warning. Fixing the `.env` would move existing dev data, so it was left as-is.
- Browser-only behaviour of this pass (mute bell, notification prompt, windowing/scroll anchoring, the entrance animation, contrast and the 360px layout, mobile keyboard) could not be executed in a real browser here — the manual checklist in the phase report covers it.

## Phase 11 — Documentation, deployment readiness & QA checklist (2026-10-18)

**Deployment**
- `CLIENT_URL` now accepts a **comma-separated list of origins**: `src/config/env.js` exports `parseClientOrigins()` + a frozen `clientOrigins` array, trims whitespace and strips trailing slashes, and rejects a list that normalizes to nothing (the value stored on `env.CLIENT_URL` is the normalized, comma-joined string). `src/app.js` (Express CORS) and `src/sockets/index.js` (Socket.io CORS) both use the array, so local dev and a deployed client can be allowed at the same time. `src/server.js` logs the allowed origins as a list at boot.
- `server/.env.example` documents the list form with an example.
- `client/public/_redirects` (`/* /index.html 200`) — SPA fallback for Netlify.
- `client/vercel.json` — rewrite of every path to `/index.html` for Vercel SPA routing.
- Root `package.json` gained a `test` script (`npm --prefix server test && npm --prefix client test`).
- Confirmed the required pieces were already in place: `app.set('trust proxy', 1)`, the server binding `process.env.PORT` (zod-validated `PORT`, default 5000) and the root `start`/`build` scripts.

**Tests**
- `server/tests/cors.test.js` (4 tests, node:test, no database): origin-list normalization, the frozen `clientOrigins` array, Express allowing every configured origin (health + preflight) while a foreign origin gets no CORS headers, and the Socket.io handshake honouring the same list.

**Docs**
- `README.md` rewritten: overview, features, tech stack, architecture (REST vs Socket.io responsibilities + the three data models), the Security section (kept, now linked from the top), folder structure, server/client environment variable tables, local setup (Atlas or local MongoDB), a run-tests section, the full **Socket.io event reference** (event, direction, payload, ack), a **Deployment** section (Render/Railway for the server — Vercel/Netlify cannot host Socket.io — Vercel/Netlify for the client, host env vars, Atlas network access, free-tier sleep caveats) and a **Troubleshooting** section (MongoDB connection, CORS, socket connection, "Unable to decrypt", read receipts).
- `QA_CHECKLIST.md` (new): an 18-section manual pass covering register/login/logout, direct chat, realtime send/receive, offline delivery, typing, presence/last seen, ticks, unread badges, delete for everyone, all group operations, key rotation after removal, database encryption verification, the fingerprint dialog, refresh persistence, second-device login, dark mode, the mobile layout and reconnection after a server restart — each with concrete steps, expected results and `mongosh` commands.

**Verified**
- `node --test tests/cors.test.js` → 4/4 pass.
- `npm test` (server) → **67/67 pass** on Atlas `chatwave_test` (63 existing + 4 new CORS tests). `npm test` (client) → **24/24 pass**. Root `npm test` (server then client) → exit code 0.
- `npm run build` (root) → vite build succeeds: 115 modules, 411.75 kB JS (124.82 kB gzip) + 40.09 kB CSS; the SPA fallback file is copied to `dist/_redirects`, `client/vercel.json` parses to `/(.*) → /index.html`, and the built bundle contains the configured `VITE_API_URL`/`VITE_SOCKET_URL` values. No changes were needed to the client code for deployment.
- Production boot: `NODE_ENV=production PORT=5060 CLIENT_URL="http://localhost:5173,https://chatwave.vercel.app" node src/server.js` → JSON log lines (production format), `MongoDB connected` (db `test`), `ChatWave API listening on http://localhost:5060` with `clientOrigins: ["http://localhost:5173","https://chatwave.vercel.app"]`; `GET /api/health` → 200 `{"status":"ok"}`; `GET /api/conversations` without a token → 401; CORS preflight from the **second** configured origin → 204 + `Access-Control-Allow-Origin: https://chatwave.vercel.app`; a foreign origin → 200 with **no** CORS header (intended block); the process was stopped after the check.
- An invalid `CLIENT_URL` (`" , "`) is rejected at boot: `CLIENT_URL must contain at least one origin …`, exit 1.
- Not verified here: the deployment steps themselves (no Render/Railway/Vercel/Netlify account was used) and all browser-only behaviour — see the phase report.

## Phase 12 — Deployment: everything on Vercel (2026-10-18)

Vercel's WebSocket support for Functions (public beta, Fluid compute) made an
all-Vercel deployment possible: the client becomes a static Vite build and the
Express + Socket.io API becomes one Vercel Function. The repository now ships
the two pieces that needed changing, everything else already fit (env-driven
URLs, comma-separated `CLIENT_URL`, the SPA rewrite in `client/vercel.json`).

**Server**
- `server/index.js` (new) — the serverless entry Vercel deploys: it connects to
  MongoDB on cold start, creates the HTTP server from `src/app.js`, attaches
  Socket.io and **default-exports the `http.Server`** (the pattern Vercel's
  WebSocket beta documents for Node servers, and what routes both `/api/*`
  REST traffic and the `/socket.io/*` WebSocket upgrade through one Function).
  No `listen()`, no presence-heartbeat interval, no signal handlers — those
  belong to the long-lived `src/server.js`, which is untouched and still what
  `npm start` / `npm run dev` / Render / Railway use.
- `server/package.json` — `"main": "index.js"` so the entrypoint is pinned.
  Vercel's zero-config Express detection scans `app`, `index`, `server`,
  `src/app`, `src/index`, `src/server` (first match wins) and the newer backend
  resolver honours `package.json#main` first; both now resolve to `index.js`.
  This matters: `src/app.js` also matches and exports the bare Express app, so
  a wrong pick would silently drop Socket.io. (`src/server.js` deliberately
  carries no `express` import, so it is not a candidate of the older scan.)

**Client**
- `src/services/socket.js` — the socket now forces `transports: ['websocket']`.
  Vercel's Functions cannot do Socket.io's HTTP long-polling (the connection is
  pinned to one instance), and the WebSocket transport works everywhere else
  too (local dev, Render/Railway). Comment added at the option.

**Docs**
- `README.md` — Deployment section rewritten: two Vercel projects from one repo
  (`server` + `client` root directories), the exact env vars per project, the
  order of operations (API first, then client, then `CLIENT_URL` + API
  redeploy), the Vercel caveats (300 s connection ceiling on Hobby with
  automatic client reconnect, per-instance rooms/presence without a shared
  adapter, websocket-only transport, memory billed while a connection is open)
  and the unchanged Render/Railway alternative. Folder structure updated
  (`server/index.js`), troubleshooting updated (the old "WebSockets cannot work
  on Vercel" note replaced by the beta's real behaviour).

**Verified**
- `npm run build` (root) → vite build succeeds: 115 modules, 411.77 kB JS
  (124.83 kB gzip) + 40.09 kB CSS.
- `npm test` (root) → server **67/67 pass**, client **24/24 pass** (no
  behavioural change).
- Throwaway entry smoke on the real Vercel entry (`server/index.js` imported
  with `NODE_ENV=production`, given its own listener like the platform does) →
  **10/10 checks**: default export is an `http.Server`; Socket.io is attached
  (`/socket.io`); `GET /api/health` → 200 `{"status":"ok"}`; a protected route
  without a token → 401 `AUTH_REQUIRED`; register → 201; a `socket.io-client`
  with `transports: ['websocket']` completes the handshake on the websocket
  transport and receives `presence:snapshot`; a bad token is rejected with
  `INVALID_TOKEN`; the throwaway user was removed afterwards.

**Notes / assumptions**
- The Vercel deployment itself could not be executed here (no Vercel account)
  and WebSockets on Vercel are in public beta. What is verified is the entry
  contract the platform consumes; the routing/upgrade behaviour after deploy
  must be confirmed with the steps in the README (health check, then a chat
  between two browsers).
- Accepted trade-offs of the all-Vercel route (documented in the README): a
  socket is closed when its function reaches 300 s (Hobby maximum) and the
  client reconnects — a short "Connecting…" banner every ~5 minutes; a
  reconnecting client may land on a different function instance, so presence /
  rooms join state is per instance until it reconnects (all durable state is in
  MongoDB, a refresh always re-syncs); long-polling is unavailable.
- Command limits/regions are unchanged; the API stays a single region (default)
  which is also what keeps a small demo on one warm instance.
- The pre-existing Windows-only `querySrv` DNS retry in `src/config/db.js`
  still logs a warning per test file locally; it does not affect Vercel
  (working DNS) and is unrelated to this phase.

## Phase 13 — Vercel Services: one project, two services (2026-10-18)

Replaced the Phase 12 two-project layout with **one Vercel project that declares
two services**, so the client and the API share a domain and a single deployment.
Routing is owned by a new root `vercel.json`; no service binding is declared,
because none can be (see below).

**Root**
- `vercel.json` (new): `services.client` (`root: client`, `framework: vite`) and
  `services.server` (`root: server`, `framework: express`,
  `entrypoint: index.js` — pinned so Vercel can never resolve to `src/app.js`,
  which would silently drop Socket.io). Public rewrites, most specific first:
  `/api/(.*)` → `server`, `/socket.io/(.*)` → `server` (the WebSocket upgrade),
  `/(.*)` → `client`. Vercel forwards the **original** path into a service, so
  Express keeps its `/api` mounts and Socket.io its `/socket.io` path with no
  code change.
- The client service carries the SPA fallback (`/(.*)` → `/index.html`) that
  used to live in `client/vercel.json`; that file is deleted so routing has one
  source of truth.
- **No bindings, deliberately:** a binding injects an internal URL into
  server-side functions at runtime only — it never reaches a static browser
  build, and it does not resolve during builds. The ChatWave client is a Vite
  SPA running in the visitor's browser, so it reaches the API through the public
  rewrites; the API makes no outbound calls at all (no `fetch`/`http.request` in
  `server/src`), so there is no service-to-service call to bind.

**Client**
- `src/services/socket.js`: when `VITE_SOCKET_URL` is unset, a production build
  now connects to the **page's own origin** (`io(undefined, …)` → whatever URL
  served the app) instead of baking in `http://localhost:5000`. A set value is
  still used verbatim, and the development fallback + warning are unchanged.
- `src/services/api.js`: unchanged — it already falls back to the relative
  `/api` path when `VITE_API_URL` is unset.
- `.env.example`: documents that both variables are for local dev only and must
  stay unset on Vercel (one origin there).

**Docs**
- `README.md`: Deployment rewritten for services mode — the routing table, why
  both services are public and why there are no bindings, the single-project
  setup (root directory = repository root, env vars, no `VITE_*`), CORS reduced
  to the "other origins" case, `vercel dev` for testing the routing table
  locally, and the Render/Railway alternative kept (which does need the absolute
  `VITE_*` values again). Client env table marks both variables optional with
  their defaults; folder structure and the socket/CORS troubleshooting entries
  updated.

**Verified**
- `npm run build` (root, with the local `client/.env`) → 115 modules, 411.77 kB
  JS (124.83 kB gzip) + 40.09 kB CSS; the bundle still contains the absolute
  `http://localhost:5000` values (local-dev behaviour unchanged).
- The same build with `client/.env` momentarily moved away (the Vercel case) →
  the bundle contains **0** occurrences of `localhost:5000`, the dev warning
  string is eliminated, and the `/api` fallback is present: the deployed app
  talks to its own origin only.
- `npm test --prefix client` → **24/24 pass**.
- `vercel.json` validated against Vercel's published schema
  (<https://openapi.vercel.sh/vercel.json>, downloaded fresh in this session)
  with a throwaway subset validator → **valid**, including `services`, the
  service-targeted `rewrites` destinations and the service object keys.
- Server boot: `PORT=5099 node src/server.js` → `MongoDB connected`,
  `ChatWave API listening on http://localhost:5099`, `GET /api/health` → 200
  `{"status":"ok"}`, `GET /api/conversations` without a token → 401. (The
  pre-existing `MONGODB_URI` warnings — unencoded `@`, no database name —
  appeared exactly as before.)

**Notes / assumptions**
- Neither `vercel dev` nor a real deployment could be executed here (no Vercel
  CLI or account in this environment), so the routing table is unverified by
  execution — it is validated against the published schema and the Services
  documentation only. After deploying, check `/api/health`, a hard refresh on
  `/login`, and a live socket.
- Assumed the single-origin layout is wanted: both services public through the
  top-level rewrites. Keeping the API internal is not an option while the client
  is browser code — a binding cannot be used from the browser, so the API would
  be unreachable.
- `client/public/_redirects` (Netlify fallback) is still copied into `dist`;
  harmless on Vercel and left untouched.
- The service names `client` / `server` follow the directories and the suggested
  config; renaming them means updating the `services` keys and the two service
  rewrites.

## Fix — Desktop chat scroll (2026-10-18)

**Bug:** on desktop, once a conversation got long, the whole page grew taller
instead of the message list scrolling, and the mouse wheel did nothing over the
chat.

**Cause:** `.chat-layout` declared only `grid-template-columns`, so its single
**implicit row was `auto`** and grew to the message list's full content height.
That left `.chat-panel` (and `.chat-body` inside it) unconstrained, so
`overflow-y: auto` never engaged — the list expanded, the shell overflowed
`100dvh`, and the document became the scroll container (unreachable under the
cursor).

**Changed**
- `client/src/styles/global.css`:
  - `.chat-layout`: added `grid-template-rows: minmax(0, 1fr)` — the row is now
    clamped to the shell height instead of hugging the content.
  - `.chat-panel` and `.chat-sidebar`: added `min-height: 0` to override the
    grid items' automatic content minimum, so both panes stay inside their row
    and `.chat-body` / `.chat-sidebar__list` are the scroll containers.
  - No markup or behaviour changes; `overscroll-behavior: contain` on
    `.chat-body` now works as intended (wheel stays in the chat at the ends).

**Verified**
- `npm run build --prefix client` → 115 modules, 40.15 kB CSS, built OK.
- Browser-level scroll behaviour could not be exercised here (no browser in this
  environment); see the manual checklist for the visual pass.



