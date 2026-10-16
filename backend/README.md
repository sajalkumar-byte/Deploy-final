# Task and Project Tracker – Node.js backend

A complete backend for the tracker: accounts, roles, items, exports and an audit log.
Accounts, roles, items, exports, an audit log and one-to-one chat. Storage is either a local
SQLite file or a Google Spreadsheet, chosen with one setting.

Its only dependency is **socket.io**, for chat. Everything else, including the SQLite engine, the
Google Sheets client and the mail sender, uses Node's own built-in modules.

```
cd server
npm start
```

Then open <http://localhost:3000/>. The server also serves the existing frontend, so the page and
the API share one address and sessions work with no extra configuration.

Requires **Node 22.5 or newer** (this project is developed on Node 24). Check with `node -v`.

## First sign-in

| Role | Email | Password |
|---|---|---|
| Super admin | `admin@tracker.com` | `Admin@1234` |
| Admin | `testadmin@gmail.com` | `testpass` |

These two are created only when the database has no accounts at all. Change the passwords after
the first sign-in, from the Users dialog or `POST /api/auth/password`. Set different starting
accounts with `SEED_SUPERADMIN_*` in `.env`.

## What each role may do

The rules live in one file, [`src/model/permissions.js`](src/model/permissions.js), and the server checks them
on **every** request. The browser hides buttons using the same table, but hiding a button is not
security: if a Viewer calls the API directly they still get `403`.

| | Super admin | Admin | Superuser | Viewer |
|---|---|---|---|---|
| View everything | yes | yes | yes | yes |
| Create / edit / delete **Tasks** | yes | yes | **yes** | no |
| Create / edit / delete **Projects** and **Recurring** | yes | yes | no | no |
| Download PDF / Excel / print | yes | yes | yes | no |
| Add users and assign roles | **yes** | no | no | no |
| Read the audit log | yes | no | no | no |

Two details worth knowing:

* An edit is checked against the type **already stored**, so sending `type:"Task"` in the body of a
  request against a project does not let a Superuser through.
* Changing someone's role or password ends their other sessions immediately, so a demotion takes
  effect at once rather than at their next sign-in.

## Where the data lives

Pick with `STORAGE`:

| Value | Where rows go | Setting up |
|---|---|---|
| `sqlite` (default) | one file, `data/tracker.db` | nothing |
| `sheets` | a Google Spreadsheet, one tab per table | a service account, below |

Both drivers answer the same calls, so every route, role and test behaves identically either way.

### Storing everything in a Google Sheet

1. Google Cloud console → create a **service account** → add a **JSON key**.
2. Enable the **Google Sheets API** for that project.
3. Share the spreadsheet with the service account's `client_email`, as **Editor**.
4. Set:

```
STORAGE=sheets
GOOGLE_SHEET_ID=14Z6wY6u4WOw_HAfZp5JpNchcm1Pe7kTxXPNhWevnU68
GOOGLE_SERVICE_ACCOUNT_JSON=./service-account.json      # a path, or the JSON itself
```

The server creates a tab per table on first start: **Users, Items, Sessions, Requests, Archive,
Resets, Messages, Meta, Audit**, each with the column names as its header row. Everything the
tracker stores ends up there, so you can sort, filter, chart or export it like any other sheet.

The token is signed with Node's own crypto, so there is still nothing to `npm install` for this.

## Chat

One-to-one messaging between everyone signed in, over **Socket.IO** (a WebSocket, falling back to
long polling where one is blocked). Messages are rows like any other record, so they land in the
same SQLite file or the same spreadsheet.

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/chat/contacts` | any role – colleagues, unread counts, who is online |
| `GET` | `/api/chat/with/:email` | any role – the conversation, and marks it read |
| `POST` | `/api/chat/with/:email` | any role – send |
| `POST` | `/api/chat/read/:email` | any role |
| `GET` | `/api/chat/unread` | any role |

Socket events: the browser sends `chat:send`, `chat:read` and `chat:typing`; the server sends
`chat:message`, `chat:read`, `chat:typing` and `presence`.

A socket must prove who it is with the same session the REST API uses, by bearer token or by the
session cookie, so chat cannot be joined by anyone who is not signed in. The sender is always
taken from the session, never from the message, and typing hints are passed straight through
without being stored. Chat is open to every role: a Viewer can read the tracker only, but can
still talk to colleagues.

## Configuration

Copy `.env.example` to `.env`. Everything is optional.

| Setting | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | where to listen |
| `STORAGE` | `sqlite` | `sqlite` or `sheets` |
| `DB_FILE` | `./data/tracker.db` | the SQLite file, created automatically |
| `SERVE_STATIC` | `1` | also serve the tracker page from this server |
| `CORS_ORIGINS` | empty | exact origins allowed to call the API from elsewhere |
| `SESSION_TTL_HOURS` | `12` | how long a sign-in lasts |
| `COOKIE_SECURE` | on in production | mark cookies Secure (needed for HTTPS) |
| `LOGIN_MAX_ATTEMPTS` | `8` per 15 min | failed sign-ins before throttling |
| `RATE_MAX` | `600` per minute | general request ceiling per address |

## Forgotten passwords

The sign-in page offers **Forgot your password?**. The server emails a six-digit code, which the
person types with their new password.

Choose how mail is sent with `MAIL_TRANSPORT`:

| Value | What happens | When to use it |
|---|---|---|
| `console` (default) | the code is printed in the server log | a local or intranet install where an administrator can read the log; needs no account |
| `smtp` | the code is emailed | normal use |
| `memory` | kept in an array | the tests |

For `smtp`, set `MAIL_HOST`, `MAIL_PORT` (587 or 465), `MAIL_USER`, `MAIL_PASS` and `MAIL_FROM`.
Any provider works, including a free Gmail account with an App Password, Brevo, Mailjet or Zoho.
The SMTP client is built on Node's own `net`/`tls`, so there is still nothing to install.

The same safeguards as the Google Sheets build apply: the code is random, lasts 15 minutes, works
once, is stored only as a hash, dies after five wrong tries, is rate limited per address, gives the
same answer for unknown addresses, and signs that person out everywhere on success.

## Security

* Passwords are stored with **scrypt** and a random salt per account. They are never returned by
  any endpoint.
* Session tokens are random and stored **hashed**, so a copy of the database cannot be replayed.
* The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
* Changing requests sent with the cookie must also carry the `X-CSRF-Token` header (double-submit),
  which stops another website from acting for a signed-in person. API clients using
  `Authorization: Bearer` are exempt because browsers never attach that automatically.
* Failed sign-ins are throttled per email and address; a missing account takes the same time as a
  wrong password, so the API does not reveal who has an account.
* Every change is written to the audit log with the actor, the target and the address.

## API

All endpoints answer JSON. Errors look like `{"error":{"code":"forbidden","message":"…"}}`.
Sign in with the cookie (the browser does this) or with `Authorization: Bearer <token>`.

### Authentication

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | anyone | is the server up, is setup still needed |
| `POST` | `/api/auth/setup` | anyone, only while no account exists | create the first super admin |
| `POST` | `/api/auth/login` | anyone | sign in; returns the user, permissions, CSRF and token |
| `POST` | `/api/auth/logout` | signed in | end this session |
| `GET` | `/api/auth/me` | anyone | who am I, and what may I do |
| `POST` | `/api/auth/password` | signed in | change your own password |
| `POST` | `/api/auth/forgot` | anyone | email a six-digit reset code |
| `POST` | `/api/auth/reset` | anyone | finish the reset with that code |

### Items

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/items?type=&status=&person=&q=` | any role |
| `GET` | `/api/items/:id` | any role |
| `POST` | `/api/items` | write permission for that type |
| `PUT` | `/api/items/:id` | write permission for the stored type |
| `PATCH` | `/api/items/:id` | write permission for the stored type |
| `DELETE` | `/api/items/:id` | write permission for the stored type |
| `GET` | `/api/items/archive` | any role |
| `PUT` | `/api/items/archive/:id` | Admin and above |

An item keeps the same field names the browser already uses: `id, type, title, s, pri, f1, f2,
sd, e, sh, ms, rm`, plus `createdAt/By` and `updatedAt/By` added by the server.

### Users and access

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/users` | super admin |
| `POST` | `/api/users` | super admin |
| `PATCH` | `/api/users/:emailOrId` | super admin |
| `DELETE` | `/api/users/:emailOrId` | super admin |
| `GET` | `/api/users/:emailOrId/sessions` | super admin |
| `POST` | `/api/requests` | anyone – "please give me access" |
| `GET` / `DELETE` | `/api/requests[/:id]` | super admin |

### Reporting

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/stats` | any role |
| `GET` | `/api/export?format=json\|csv&type=&status=` | not Viewer |
| `GET` | `/api/audit?limit=&offset=&action=&actor=` | super admin |
| `GET` | `/api/roles` | anyone |

### Example

```bash
# sign in and keep the token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@tracker.com","password":"Admin@1234"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).token")

# create a project
curl -s -X POST http://localhost:3000/api/items \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"Project","title":"Core banking DR site","f1":"Amina","pri":"High"}'

# download everything as CSV
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/export?format=csv" -o tracker.csv
```

## Tests

```
npm test
```

81 tests run against a real HTTP server:

* the whole API on **SQLite**: every role's abilities and refusals, validation, sessions, CSRF,
  throttling, the audit log, the access-request flow and the forgotten-password flow;
* the whole API again on **Google Sheets**, against a stand-in for Google that verifies the
  signed service-account token, so the driver's real code path is exercised and each test checks
  what actually landed in the tab;
* **chat** over two real Socket.IO clients: delivery, presence, typing, read receipts, privacy
  between conversations, and refusing a socket that is not signed in.

## How the browser uses it

`js/api.js` in the project root implements the same small store interface that the browser already
had (`watch` / `set` / `update` / `remove`), so none of the screens changed. On start-up the page
calls `/api/health`:

* **a backend answers** – it signs in against the server, the server decides the role, and all data
  is shared between everyone;
* **nothing answers** – the page behaves exactly as before, storing data in that browser.

To host the page somewhere else (GitHub Pages, Vercel) and the API here, set `CORS_ORIGINS` on the
server and `window.API_BASE = 'https://your-server'` in the page before `js/api.js` loads.

## Files

The same Model-View-Presenter split the page uses, so one idea per folder and one place to look
when something needs changing:

* **Model** - the data and the rules. What is true, regardless of who asked.
* **View** - how an answer leaves the building: the JSON a client receives, the email a person
  reads, the socket a browser listens on, the files served to it.
* **Presenter** - what happens on a request: who is asking, may they, which model to call, which
  view to hand it to.

```
backend/
  src/
    index.js            start the server
    config.js           every setting, read from .env
    db.js               a thin name for the storage layer, kept so older imports still work

    model/
      schema.js         every table and its columns, in one place
      store/            where rows live: index.js chooses, sqlite.js and sheets.js do it
      users.js          one module per kind of record: accounts,
      sessions.js         who is signed in,
      items.js            projects, recurring items and tasks,
      messages.js         chat,
      requests.js         people waiting for an account,
      resets.js           password-reset codes,
      audit.js            who changed what
      permissions.js    the role matrix - the one place the rules live
      crypto.js         scrypt password hashing, tokens
      seed.js           the accounts a fresh install starts with

    view/
      http.js           reading a request body and writing a JSON answer
      mailer.js         the reset-code email
      realtime.js       Socket.IO: the live side of chat
      static.js         serves the page itself

    presenter/
      app.js            the request pipeline: headers, CORS, rate limit, routing, errors
      router.js         small pattern router
      middleware.js     rate limiting, session lookup, CSRF
      routes/           auth, users, items, meta, chat

  test/                 the full suite, run against a real HTTP server
  scripts/reset.js      wipe the database and reseed
```
