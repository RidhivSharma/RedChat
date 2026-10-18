# AGENTS.md — Project Rules for RedChat

These rules are binding for the entire project. Follow them for every phase and every task.

## PROJECT

Real-Time Chat App **"RedChat"** with one-on-one chat, group chat, online status, typing indicators, read receipts and end-to-end encryption.

## STRICT STACK

- **Client:** React.js (Vite, **JavaScript, not TypeScript**)
- **Server:** Node.js with Express
- **Realtime:** Socket.io (server) and socket.io-client (client)
- **Database:** MongoDB with Mongoose
- **E2E encryption:** ONLY the browser Web Crypto API (`window.crypto.subtle`). No crypto libraries on the client.
- **Styling:** No UI libraries, no Tailwind. Plain CSS with CSS variables.

### Allowed packages (only these)

- **server:** express, mongoose, socket.io, jsonwebtoken, bcryptjs, cors, dotenv, helmet, express-rate-limit, zod, nodemon (dev)
- **client:** react, react-router-dom, socket.io-client
- **root:** concurrently (dev)

### Tests

Use Node's built-in test runner (`node:test`). No extra test libraries.

## MONOREPO STRUCTURE

- `/server/src/{config,models,routes,controllers,middleware,sockets,utils}`
- `/client/src/{components,pages,context,hooks,services,utils,styles}`
- Root `package.json` with scripts:
  - `dev` — runs server and client together with concurrently
  - `build` — builds client
  - `start` — runs server
- Use ES modules (`"type": "module"`) in both packages.

## DATA MODELS (Mongoose)

### User

- `username` (unique, lowercase)
- `displayName`
- `passwordHash`
- `avatarColor`
- `publicKey` (string, JWK)
- `encryptedPrivateKey` `{ ciphertext, iv, salt, iterations }`
- `lastSeen`
- `createdAt`

### Conversation

- `type` (`"direct"` | `"group"`)
- `members` [User ids]
- `directKey` (sorted member ids joined, unique sparse, only for direct)
- `name`
- `admins` [User ids]
- `createdBy`
- `groupKeys` `[{ userId, version, wrappedKey, iv, wrappedBy }]`
- `currentKeyVersion`
- `lastMessageAt`
- `lastMessageId`
- `createdAt`

### Message

- `conversationId`
- `sender`
- `ciphertext`
- `iv`
- `keyVersion`
- `encrypted` (boolean)
- `clientId` (unique per sender, for deduplication)
- `deliveredTo` `[{ user, at }]`
- `readBy` `[{ user, at }]`
- `deletedForEveryone` (boolean)
- `createdAt`
- Index: `{ conversationId: 1, createdAt: -1 }`

## API RULES

- All routes under `/api`
- Consistent error JSON: `{ error: { message, code } }`
- Validate every request body with zod
- JWT in the `Authorization: Bearer` header
- Never trust a `userId` sent by the client — always use the one from the verified token
- Passwords hashed with bcryptjs
- Rate-limit auth routes

## SOCKET RULES

- Authenticate every socket in the handshake with the JWT (`io.use` middleware) and store `socket.data.userId`
- Every event must check that the user is a member of the conversation
- Validate every payload
- Every client emit that needs a result uses an acknowledgement callback `{ ok, data | error }`
- Never log message contents

## CLIENT RULES

- Functional components and hooks only
- All HTTP calls live in `src/services/api.js` and all socket code in `src/services/socket.js`
- Every list or view has loading, empty and error states
- All forms validate input
- No hardcoded secrets or URLs, only `import.meta.env.VITE_*` values
- Fully responsive (mobile under 768px)

## WORKFLOW

- After every task, run the relevant check (`npm run build` for the client; start the server and confirm it boots and connects to MongoDB) and fix all errors before finishing.
- Keep a short `CHANGELOG.md` updated per phase.

## PHASE VERIFICATION (required at the end of every phase)

Output a **"PHASE VERIFICATION"** section with:

1. Every file created or changed
2. The result of the build/boot check
3. A numbered manual test checklist of exactly what to click and what to see in the browser and in MongoDB
4. Assumptions made or anything that could not be verified

Do not claim a feature works unless it was actually run or built.
