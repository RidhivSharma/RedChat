# RedChat — QA Checklist

Manual test pass for the full app. Work top to bottom; every item lists what to
do and what you should see. Anything that fails is a bug — note the step number,
the browser console output and the server log line.

## Before you start

- [ ] `npm run dev` runs without errors; <http://localhost:5000/api/health>
      returns `{"status":"ok"}` and <http://localhost:5173> loads.
- [ ] `npm run build` succeeds (no warnings).
- [ ] `npm test` passes in both packages (see `README.md` → *Running tests*).
- [ ] Two independent browser sessions are ready for the two-user tests:
      a normal window for **Alice** and a private/incognito window for **Bob**
      (same browser is fine; two tabs of the *same* account is **not**, because
      read receipts only come from the other account).
- [ ] A third session (private window/another browser) is available for the
      second-device and group tests.
- [ ] MongoDB access for the database checks: `mongosh "<MONGODB_URI>"` —
      add the database name you configured. If `MONGODB_URI` has no database
      name, the data lives in the database named `test` (the server warns about
      this at boot).

---

## 1. Register, login, logout

- [ ] Open <http://localhost:5173> with no session → redirected to `/login`.
- [ ] Go to `/register`. Submit an empty form → inline errors on every field,
      nothing is sent.
- [ ] Try username `ab` → error "username must be at least 3 characters".
      Try username `bad name!` → error (only letters, digits, `_`).
- [ ] Try password `short` → error (at least 8 characters). Try a display name of
      41 characters → error.
- [ ] Register **Alice** (`alice`, display name `Alice`, password `password123`)
      → toast "Account created", redirected to the chat page, sidebar shows
      `Alice` / `@alice`.
- [ ] Register the same username again → banner "That username is already
      taken" (`409 USERNAME_TAKEN`).
- [ ] MongoDB: `db.users.find({ username: 'alice' })` → one document; it has
      `passwordHash` (a `$2…` bcrypt string, **not** the plain password),
      `publicKey` (an ECDH P-256 JWK string) and `encryptedPrivateKey` with
      `ciphertext`/`iv`/`salt`/`iterations` (310000). No plaintext password
      anywhere.
- [ ] Log out (sidebar footer → *Log out*) → back on `/login`, and a page
      refresh stays logged out. `localStorage` has no `redchat.token`.
- [ ] Log in as Alice with a wrong password → one generic error "Invalid
      username or password" (`401 INVALID_CREDENTIALS`); same message for an
      unknown username (no account enumeration).
- [ ] Log in correctly → chat page, conversations list visible, no toast errors.
- [ ] Log out and log in as **Bob** in the private window; register Bob first if
      needed.

## 2. Search and start a direct chat

- [ ] As Alice, type `bob` in the sidebar search box.
      → A spinner briefly, then Bob (avatar, display name, `@bob`).
      Debounce means the request fires ~300 ms after the last keystroke.
- [ ] Search for `zzzz` → empty state "No users found" (no error).
- [ ] Search for a string with regex characters (e.g. `.*`) → no crash, no
      results or literal matches; the query is escaped server-side.
- [ ] Click Bob → the direct conversation opens, is added to the sidebar, the
      header shows Bob with a presence line.
- [ ] As Bob, refresh; the conversation is already in his sidebar (created for
      both by the same `directKey`).
- [ ] MongoDB: `db.conversations.find({ type: 'direct' })` → **one**
      document for Alice+Bob (clicking again from either side must not create a
      second one). `members` has 2 ids, `directKey` is the two ids sorted and
      joined.

## 3. Send and receive in real time

- [ ] As Alice, type a message and press Enter.
      → The bubble appears instantly on the right ("sending" clock icon), then
        the clock is replaced by a check mark when the server acks.
- [ ] Bob's window shows the message on the left **within a second**, with
      Alice's name/avatar, without any refresh.
- [ ] Bob replies → the message appears in Alice's window instantly, and Bob's
      bubble ends with a tick once delivered.
- [ ] Send a long message (> a few lines) → the composer grows, Enter sends,
      Shift+Enter inserts a line break, the character counter appears near 2000.
- [ ] Paste >2000 characters → the counter turns red and sending is blocked.
- [ ] Send 3 messages in a row → they group under one timestamp block (same
      sender, < 5 minutes apart); the first carries the avatar/name, the rest
      do not.
- [ ] Send with the network throttled/offline (DevTools → Network → Offline) →
      the bubble shows "failed" with a Retry button; back online → Retry sends
      it and **no duplicate** appears (server dedupes by `clientId`).
- [ ] MongoDB: `db.messages.find().sort({ createdAt: -1 }).limit(1)` → a
      document with `ciphertext` **not equal** to what you typed (see §12),
      a non-empty `iv`, `encrypted: true`, `keyVersion: 1`, and a `clientId`.

## 4. Offline delivery

- [ ] Bob closes his window entirely (or logs out).
- [ ] Alice sends two messages. Her bubbles show the **single grey tick**
      (= sent, not delivered).
- [ ] MongoDB: `db.messages.find({ sender: <aliceId> }).sort(...)` → newest
      messages have an empty `deliveredTo` and `readBy` array.
- [ ] Bob opens the app again and logs in.
      → The messages are in the conversation; Alice's ticks turn to the
        **double grey tick** (delivered) without Bob needing to open the chat.
- [ ] MongoDB: the two messages now have a `deliveredTo` entry for Bob with
      timestamps.
- [ ] Alice sends a message while Bob's window is open but a *different*
      conversation is selected → it still gets the double tick (he is online)
      and the sidebar badge appears.

## 5. Typing indicator

- [ ] With the direct chat open on both sides, Alice types a few characters
      **without sending**.
      → Bob's chat header shows "Alice is typing…" and Alice's sidebar row
        shows "typing…".
- [ ] Alice stops typing for ~2 seconds or deletes the text
      → the indicator disappears on both.
- [ ] Alice sends → the indicator clears immediately.
- [ ] Nobody sees their own "typing" state echoed back.

## 6. Online status and last seen

- [ ] With both users connected, the sidebar avatar shows a green online dot
      and the chat header says "online".
- [ ] Bob closes the window.
      → Within a few seconds Alice's sidebar dot turns grey and the header
        shows "last seen …" with a recent time.
- [ ] Bob reopens → the dot returns to green and the header returns to "online".
- [ ] MongoDB: `db.users.findOne({ username: 'bob' }).lastSeen` is updated
      after Bob disconnects.
- [ ] Log Alice in a second tab/window → closing one of her two tabs keeps her
      online until the last one closes.

## 7. Delivered and read ticks

- [ ] Tick legend while testing: **1 grey** = sent, **2 grey** = delivered,
      **2 blue** = read.
- [ ] Alice sends while Bob is offline → single grey tick.
- [ ] Bob comes online → double grey tick (delivery catch-up).
- [ ] Alice sends while Bob's chat is **open and visible** → Bob's client sends
      the read receipt → Alice's tick turns **blue** within ~1 second.
- [ ] Alice sends while Bob's chat is open but his tab is hidden
      (switch to another tab) → the tick stays double grey until Bob returns to
      the tab and the list is at the bottom.
- [ ] Click/tap the tick button on one of Alice's messages → the message info
      dialog lists Bob under *Delivered* and *Read* with exact times.
- [ ] Group rule: in a 3-person group, if only one of the two others has read
      the message, the tick stays double grey (not blue); the info dialog lists
      who is missing. Both read → blue.

## 8. Unread badges

- [ ] Bob selects a different conversation, Alice sends 3 messages
      → Bob's sidebar shows a `3` badge on the Alice row and the tab title
        becomes `(3) RedChat`.
- [ ] Bob opens the Alice conversation with the tab visible, scrolled to the
      bottom → the badge disappears immediately and the title loses the prefix.
- [ ] Bob scrolls up mid-history, Alice sends → the new message does not
      auto-read; a "1 new message" pill appears; scrolling to the bottom clears
      it and sends the read receipt.
- [ ] Bob's tab hidden while the conversation is open, Alice sends → the badge
      grows anyway; returning to the tab and scrolling to the bottom clears it.
- [ ] Alice never sees a badge for her own messages.
- [ ] MongoDB: `db.messages.findOne({...})` after reading → `readBy` contains
      Bob's id; `db.conversations` has no stored `unreadCount` field (it is
      computed per request).

## 9. Delete a message

- [ ] Hover one of Alice's messages → a trash icon appears (own messages only).
- [ ] Click it → confirm dialog → confirm.
      → Both Alice and Bob see "This message was deleted" in place of the text
        (no content, no avatars change), on both sides, in real time.
- [ ] MongoDB: the message has `deletedForEveryone: true` and
      `ciphertext: ''` (plus `iv` cleared) — the text is gone from the database,
      not just hidden.
- [ ] Deleting an already-deleted message does nothing (idempotent, no error).
- [ ] Bob cannot see a trash icon on Alice's messages and cannot delete them via
      the API: `DELETE /api/messages/<id>` with Bob's token →
      `403 NOT_MESSAGE_SENDER` (use curl/Postman).
- [ ] Deleting a message does not change read/delivered ticks.

## 10. Group chat

- [ ] As Alice, click **New group** → dialog opens.
- [ ] Submit with an empty name → inline validation error.
- [ ] Type a name and search for `bob`; select Bob, then also add a third user
      (**Carol** — register one first if needed); the selected members appear as
      chips and are excluded from the next search results.
- [ ] Click **Create group** → the group opens in the sidebar, header shows
      `3 members`, and Bob/Carol get the group in their sidebar immediately
      (creation itself adds no system line — the first one appears with the
      next membership change).
- [ ] Send a message in the group → all members receive it with Alice's colored
      display name; each member's own messages are on the right.
- [ ] As Alice (admin), open the group info panel (header button):
      rename the group → all members' sidebars/headers update instantly and a
      system line `Alice renamed the group to "…"` appears.
- [ ] Promote Bob → Bob shows an admin badge; Bob can now open the info panel's
      admin actions (rename/add/remove/promote). A system line records the
      promotion. Promoting Bob twice adds nothing the second time.
- [ ] As Bob (non-admin before promotion could be tested with Carol): verify
      Carol cannot see admin actions, and that a direct API call is rejected:
      `POST /api/conversations/<id>/members` with Carol's token →
      `403 NOT_GROUP_ADMIN`.
- [ ] Add a fourth user through **Add members** → everyone sees the updated
      member count and a system line; the newcomer sees the group with no unread
      badge for old messages.
- [ ] Remove a member → that member's window closes the group (if open), the
      group disappears from their sidebar and a notice "You are no longer a
      member of “…”" appears. The removed member can no longer send (403) and
      receives no further real-time messages.
- [ ] **Leave group** as a non-admin member → same removal behaviour, but *no*
      "you were removed" notice (`left: true`).
- [ ] As the **last admin**, leave → the earliest remaining member is promoted
      automatically, a system line "… is now an admin" appears, and the group
      stays healthy.
- [ ] Last member leaving deletes the conversation and its messages (only test
      on a throwaway group).

## 11. Key rotation after removal

- [ ] In a group with Alice (admin), Bob and Carol, send a message so all
      members can decrypt v1. MongoDB: `db.conversations.findOne({_id: <id>})`
      → `currentKeyVersion: 1`; the message has `keyVersion: 1`.
- [ ] Alice removes Carol.
      → The remaining members' clients rotate: MongoDB →
        `currentKeyVersion: 2`, and `groupKeys` contains version-2 envelopes
        for **Alice and Bob only** (never Carol).
- [ ] Send a new message in the group.
      → It is stored with `keyVersion: 2`; Alice and Bob read it fine; Carol
        (already removed) cannot join the conversation at all
        (`403 NOT_A_MEMBER` via API) and even with the old key could not read
        the new message (it is encrypted with the v2 key she never received).
- [ ] Carol's old copies of v1 messages remain readable *on her device* (keys
      cannot be recalled) — expected and documented in the README Security
      limitations.
- [ ] With **two admins**, remove a member → only one rotation lands
      (`currentKeyVersion` increases by exactly 1); the losing client adopts the
      winner's key and still decrypts. No `STALE_KEY_VERSION` error surfaces to
      the UI.
- [ ] After a rotation, an added member receives wrapped keys for every
      existing version and can read new messages immediately.

## 12. Encryption verification in the database

- [ ] Send a message with a distinctive plaintext, e.g.
      `redchat-marker-12345`, then in `mongosh`:

      ```js
      use redchat                     // or the db name you configured
      db.messages.findOne({ ciphertext: { $regex: 'redchat-marker', $options: 'i' } })
      // → null: the plaintext is nowhere in the collection

      db.messages.find().sort({ createdAt: -1 }).limit(1).pretty()
      // → ciphertext: a base64 blob, iv: 12-byte base64, encrypted: true
      ```

- [ ] Search the whole collection for the marker to be sure:
      `db.messages.countDocuments({ ciphertext: /redchat-marker/i })` → `0`
      (the index on `ciphertext` is not needed — this is a one-off visual check).
- [ ] System messages (membership activity) are the only plain-text rows
      (`type: "system"`, `encrypted: false`) and contain no chat text.
- [ ] `db.users.findOne({ username: 'alice' })`:
      `passwordHash` starts with `$2`, `publicKey` is a JWK **string**,
      `encryptedPrivateKey.ciphertext` is base64 and unreadable, no plaintext
      private key anywhere.
- [ ] `db.conversations.findOne()`: `groupKeys[n].wrappedKey` is base64, and
      every envelope names its target `userId`/`version` (never readable keys on
      their own).
- [ ] With `REQUIRE_E2EE=true` in `server/.env`, restart the server and POST a
      plaintext payload with curl —
      `{"ciphertext":"plain","iv":"","encrypted":false,"clientId":"qa-1"}` →
      `400 ENCRYPTION_REQUIRED` and nothing is stored; the UI still works
      normally because it always encrypts (`encrypted` defaults to `true`, so
      omitting it would instead fail validation with a missing `iv`).

## 13. Key fingerprint dialog

- [ ] Open a direct chat → click the lock chip in the header
      ("Messages are end-to-end encrypted") → the **Verify encryption** dialog
      opens with a fingerprint (SHA-256 of both public keys, grouped hex).
- [ ] On Bob's side, open the same dialog → the fingerprint is **identical**
      (the hash is order-independent).
- [ ] In a group, open the dialog → one fingerprint per member is listed
      (comparing them confirms everyone shares the same key versions).
- [ ] Close the dialog (Escape / backdrop click) → no state change, no error.
- [ ] A changed key (e.g. Bob logs in after his account was re-keyed) would
      produce a different fingerprint — this is how you detect a swapped key.

## 14. Refresh persistence

- [ ] With both windows loaded, refresh Alice's page.
      → Full-page spinner briefly, then she is still logged in (no `/login`),
        her conversations and history are there, and the open conversation is
        restored from the URL.
- [ ] No "unlock password" prompt appears on refresh — the private key is a
      non-extractable `CryptoKey` in IndexedDB, and messages still decrypt.
- [ ] Presence is correct after the refresh (her own dot is online again).
- [ ] Deep-link test: with the session active, open
      `http://localhost:5173/login` directly → redirected to the chat page
      (already signed in); open an unknown path → the 404 page.
- [ ] Hard refresh while on `/login` after logging out → stays on `/login`.

## 15. Second-device login

- [ ] In a second browser profile (clean site data), log in as Alice.
      → Because no private key exists on this device, the **unlock screen**
        appears and asks for Alice's password.
- [ ] Enter a **wrong** password → clear error, still locked, no plaintext
      messages leak.
- [ ] Enter the correct password → the private key backup is restored (the key
      is imported as non-extractable), the conversation opens and all messages
      decrypt.
- [ ] Send a message from device 2 → device 1 receives it in real time.
- [ ] Open the direct chat on device 2, then read a message sent by Bob
      → device 1 shows the read tick too (receipts are per user, not per
        device).
- [ ] Log out on device 2 → the stored key for that profile is deleted
      (IndexedDB cleared) and a later login asks for the password again.
- [ ] Refresh device 2 → no second unlock (the restored key persists in
      IndexedDB).

## 16. Dark mode

- [ ] Click the theme toggle (moon/sun) in the sidebar footer.
      → The whole app switches to dark (backgrounds, bubbles, badges, modals),
        including the login page after logging out.
- [ ] Refresh → the theme is remembered (`localStorage: redchat.theme`) with no
      white flash on load.
- [ ] Reload on a mobile viewport → the theme still applies (button is
      reachable on small screens).
- [ ] Check contrast in both themes: timestamps, hints and placeholders remain
      readable (no light-grey-on-white).

## 17. Mobile layout

- [ ] In DevTools, switch to a 375 × 812 device (and again at 360 px width).
      → Only one pane is visible at a time: the conversation list first, then
        the chat pane with a back button in the header.
- [ ] Open a conversation → the chat pane fills the screen; the header still
      fits the title, lock chip and group-info button at 360 px.
- [ ] The composer stays visible above the on-screen keyboard (tap the textarea
      in device emulation) and the message list scrolls.
- [ ] Send a message → bubbles are full-width-ish and readable; the sidebar is
      one tap away via the back button.
- [ ] New group dialog and group info panel are usable full-screen; their
      buttons are not cut off.
- [ ] Rotate to landscape → layout still works, no horizontal scrollbar.

## 18. Reconnection after a server restart

- [ ] With Alice and Bob both online, stop the server (Ctrl+C in the terminal
      running `npm run dev`, or the server process only).
      → Both windows show the connection banner (e.g. "Connecting…"/"Offline");
        Alice sending now produces a failed/retry bubble, not a lost message.
- [ ] Start the server again (`npm run dev` or `npm start`).
      → Within a few seconds the banner disappears, presence updates and the
        sidebar refreshes; no page reload needed.
- [ ] Alice retries the failed message (Retry button) → it is delivered once
      (dedupe prevents duplicates) and Bob receives it.
- [ ] Read receipts resume: Bob opens the conversation and Alice's ticks turn
      blue.
- [ ] Restart the server while a message list is scrolled deep in history →
      after reconnect the position is kept (or a fresh page loads) with no
      duplicate messages.
- [ ] MongoDB: no duplicate messages were created by the restart/retry
      (`db.messages.aggregate` grouping by `clientId` shows count 1).

---

## Extra robustness checks (optional)

- [ ] Open a second tab as Alice → both tabs stay in sync (messages, deletes,
      presence); closing one keeps her online.
- [ ] Expire the session (`localStorage` → change `redchat.token` to garbage,
      then send a message) → the app force-logs out and explains the expiry on
      the login page.
- [ ] Send 25 messages quickly → after 20 within 10 s the server answers
      `429 RATE_LIMITED`; the UI shows the error toast and the app stays usable.
- [ ] Request `GET /api/conversations/<other-users-conversation>` with a valid
      token from a non-member → `403 NOT_A_MEMBER` (no data leakage).
- [ ] Check the server log: request lines contain method, path, status and
      duration — **never** message contents, tokens or passwords.

## Known behaviour that is *not* a bug

- A removed group member can still read the messages they already received
  (keys cannot be recalled) — see README → Security → Limitations.
- Metadata (who talks to whom, timestamps, receipts, presence) is visible to the
  server by design.
- The backend never sees plaintext, so it cannot search message text.
- A hidden tab does not mark messages as read (by design).
