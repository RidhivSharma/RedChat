# ChatWave

Real-time chat app with one-on-one and group chat, online status, typing
indicators, read receipts and end-to-end encryption.

**Stack:** React (Vite, JavaScript) · Node.js + Express · Socket.io · MongoDB + Mongoose ·
browser Web Crypto API (no crypto libraries on the client).

## Getting started

```bash
npm install                 # in the repo root, /server and /client
cp server/.env.example server/.env   # then fill in MONGODB_URI and JWT_SECRET
cp client/.env.example client/.env
npm run dev                 # server + client together
```

| Script          | What it does                         |
| --------------- | ------------------------------------ |
| `npm run dev`   | server and client with `concurrently` |
| `npm run build` | production build of the client        |
| `npm start`     | runs the server                       |

Tests use Node's built-in runner: `npm test` inside `server/` (needs MongoDB; uses
a separate `<db>_test` database) and inside `client/` (crypto module, no database).

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
