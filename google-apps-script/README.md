# Google Sheets backend (Google Apps Script)

Use a Google Spreadsheet as the tracker's database. Everyone shares one live set of data, there is
no server to rent or maintain, and the records stay in a sheet you own and can open, filter and
chart like any other.

This is an alternative to the Node.js server in [`../backend`](../backend). Pick one. Both enforce
the same four roles, and the page works with either without any change to its screens.

| | Google Sheets | Node.js server |
|---|---|---|
| Hosting cost | free | needs a host that runs Node |
| Setup | paste a script, click Deploy | `npm start` |
| Works with the page on GitHub Pages / Vercel | yes | only if the server is reachable |
| Speed of each action | roughly 0.5–2 seconds | instant |
| Good for | a team up to a few thousand rows | any size |

---

## Set it up (paste 15 lines, not 1,249)

**1. Make the spreadsheet**

Open <https://sheets.new> and name it, for example *Task Tracker Database*.

**2. Paste the script**

In that sheet choose **Extensions → Apps Script**. Select everything in the editor and replace it
with the whole of [`Code.gs`](Code.gs). Save with Ctrl+S.

It is one complete, self-contained file of about 1,260 lines. Nothing else is needed and it
downloads nothing: the tracker is all there.

Three ways to be sure you have the right file before you save:

| Check | The script | The wrong file |
|---|---|---|
| Length | about 1,260 lines | 269 lines |
| First line of code | `var SHEETS = {` | `(function (global) {` |
| Search for `window.` | no results | ends with `})(window);` |

> There is also [`Loader.gs`](Loader.gs), a fifty-line alternative that downloads this same code
> at run time. Its advantage is that later improvements arrive without pasting again. Its cost is
> that Apps Script cannot see what the downloaded code will do, so the loader has to declare the
> permissions itself. Use whichever you prefer; the full file is the simpler of the two.

**3. Run the setup once**

In the Apps Script toolbar pick **`setupTracker`** and press **Run**, then allow the permissions
(*Advanced → Go to project → Allow*). The log prints the sign-in to use:

```
Super admin created.
  email:    admin@tracker.com
  password: Admin@1234
```

Optional extras, run the same way:

| Function | What it does |
|---|---|
| `addSampleData` | writes thirteen realistic projects, recurring items and tasks |
| `addSampleUsers` | one account per role for testing |
| `rebuildViews` | recreates the per-role tabs, after a role change or an accidental edit |
| `checkDeployment` | checks the installation and prints what is wrong, if anything |
| `refreshTrackerCode` | pulls the newest code immediately instead of waiting for the cache |

**4. Publish it as a Web App**

**Deploy → New deployment → ⚙ → Web app**, with **Execute as: Me** and
**Who has access: Anyone**. Copy the `/exec` URL.

If a deployment already exists, use **Deploy → Manage deployments → ✏ → Version: New version →
Deploy** instead. The URL stays the same.

**5. Point the page at it**

The URL already sits in [`../index.html`](../index.html). Replace it there if yours is different:

```html
<script>window.GAS_URL='https://script.google.com/macros/s/..../exec';</script>
```

Open the `/exec` URL in a browser to check it. It should print `{"ok":true,...}`. An error page
means the wrong code is in the editor, or step 4's new version was skipped.

### Keeping it up to date

After pasting the full `Code.gs`, a later improvement means pasting the new version over the old
one and redeploying: **Deploy → Manage deployments → ✏ → Version: New version → Deploy**.

If you used `Loader.gs` instead, changes to `Code.gs` in this repository reach the deployment by
themselves within an hour, or immediately if you run `refreshTrackerCode`.

### If a permission prompt does not appear

Apps Script asks for permissions the first time a script needs them, and remembers the answer. If
you replaced earlier code with this and saw *"Specified permissions are not sufficient"*, the old,
narrower approval is still in force. Go to <https://myaccount.google.com> → **Data & privacy** →
**Third-party apps and extensions**, remove this project, then run `setupTracker` again and accept
the fuller prompt.

---

## What each role may do

The rules are in one place in `Code.gs` (`WRITABLE_TYPES` and `CAPABILITIES`) and are checked on
every request. Hiding a button in the browser is convenience; this is the part that protects the
data.

| | Super admin | Admin | Superuser | Viewer |
|---|---|---|---|---|
| View everything | yes | yes | yes | yes |
| Create / edit / delete **Tasks** | yes | yes | **yes** | no |
| Create / edit / delete **Projects** and **Recurring** | yes | yes | no | no |
| Download PDF / Excel / print | yes | yes | yes | no |
| Add users and assign roles | **yes** | no | no | no |
| Read the audit log | yes | no | no | no |

Two things worth knowing:

* An edit is checked against the type **already in the sheet**, so sending `type:"Task"` for a
  project does not let a Superuser through.
* Changing someone's role or password ends their other sessions at once, so a demotion applies
  immediately instead of at their next sign-in.

## Forgotten passwords

The sign-in page has a **Forgot your password?** link. The person types their email, the script
emails them a six-digit code, and they type that code with the new password they want.

Sending is free and needs no setup: the mail goes through Gmail using the Google account that owns
the script. A consumer account may send about 100 emails a day, a Workspace account about 1500.
`checkDeployment` prints how much of today's quota is left.

Safeguards, all enforced in the script:

* The code is random, lasts 15 minutes and works once.
* Only a SHA-256 hash of it is written to the `Resets` tab, so the sheet never shows a usable code.
* Five wrong tries throw the code away.
* One address may request five codes an hour, so nobody can be mail-bombed.
* The answer is the same whether or not the address has an account, so the page cannot be used to
  discover who is registered.
* A successful reset signs that person out everywhere.

Tune `RESET_CODE_MINUTES`, `RESET_MAX_TRIES` and `RESET_MAX_REQUESTS` near the top of `Code.gs`.

## The tabs

| Tab | Holds | Safe to edit by hand? |
|---|---|---|
| `Users` | email, name, role, hashed password | Name and role yes. Never type a password here – it must be hashed. |
| `Items` | every project, recurring item and task, with the role that created each | Yes, if you keep the column order |
| `Sessions` | who is currently signed in | Clearing it signs everyone out |
| `Requests` | people waiting for an account | Yes |
| `Archive` | older tasks kept for reference | Leave to the app |
| `Resets` | hashed password-reset codes, short-lived | Leave to the app |
| `Audit` | who changed what, and when | Append-only; do not edit |

And one tab per role, rebuilt from the data rather than written to:

| Tab | Holds |
|---|---|
| `Super admin data`, `Admin data`, `Superuser data`, `Viewer data` | everything that role created, grouped by type |
| `Admin Projects`, `Admin Recurring`, `Admin Tasks` | that role's work, one type per tab |
| `Super admin Projects`, `Super admin Recurring`, `Super admin Tasks` | the same for the super admin |
| `Superuser Tasks` | a Superuser may only create Tasks, so that is the only tab it gets |
| `Accounts by role` | who holds which role, every column but the password |

Each of these holds a single live `FILTER` formula over `Items`, so they follow the data on
their own: add a row in the page, edit one in `Items`, or delete it, and every tab that should
show it changes with it. Nothing is written twice, so the views cannot drift out of step.

Which tabs exist comes from the permission model, so a role that cannot create Recurring items
never gets an empty Recurring tab. Type over one by accident and `rebuildViews` puts it back.

Because `Items` is an ordinary sheet you can build pivot tables, charts and Looker Studio reports
straight on top of the live data.

## Settings

Project Settings → Script Properties:

| Property | Purpose |
|---|---|
| `SEED_EMAIL`, `SEED_NAME`, `SEED_PASSWORD` | the first super admin, read only by `setupTracker` |
| `SHEET_ID` | use a different spreadsheet instead of the one the script is attached to |

In `Code.gs` near the top: `SESSION_HOURS` (how long a sign-in lasts), `HASH_ROUNDS` (password
hashing effort, raise it for more protection or lower it if sign-in feels slow),
`LOGIN_MAX_ATTEMPTS` and `LOGIN_WINDOW_MIN`.

## Security

* Passwords are stored as salted SHA-256, repeated `HASH_ROUNDS` times. The sheet never holds a
  password as typed.
* Session tokens are random, and only their hash is written to the `Sessions` tab, so a copy of
  the spreadsheet cannot be replayed as a live sign-in.
* Failed sign-ins are throttled per email.
* Every change is appended to `Audit` with the person, the target and the time.
* Writes are serialised with a script lock, so two people saving at the same moment cannot
  corrupt a row.

One honest limitation: Apps Script Web Apps cannot read custom request headers, so the session
token travels in the request body and is kept in each browser's own storage rather than in a
`HttpOnly` cookie. Always use the `https://script.google.com/...` URL so it is encrypted in
transit. If that matters for your data, use the Node.js server instead, which uses cookies.

## Limits

Google's free quotas are generous for a tracker of this size: roughly 20,000 script calls per day
for a consumer account and 90 minutes of total run time. The page refreshes every 12 seconds while
a tab is open and in the foreground, so ten people working all day stay well inside that. Raise
`pollMs` in [`../js/gsheet.js`](../js/gsheet.js) if you want even less traffic.

## Tests

The script can be tested before it is deployed. `test/harness.js` stands in for Google's services
with an in-memory spreadsheet and runs the real `Code.gs`:

```
cd google-apps-script
node --test
```

28 tests cover every role's abilities and refusals, password hashing, sessions, validation,
throttling, the audit log, the access-request flow and id numbering.

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| The page never leaves "Connecting…" | `GAS_URL` is wrong or the deployment is not "Anyone". Open the URL in a browser: it should print JSON. |
| "The script did not answer with data" | Google returned its sign-in page. Redeploy with **Who has access: Anyone**. |
| Changes to `Code.gs` have no effect | Redeploy a **new version**; the old one keeps serving otherwise. |
| "Authorization required" when running `setupTracker` | Accept the permission prompt: *Advanced → Go to project → Allow*. |
| Sign-in is slow | Lower `HASH_ROUNDS`, or accept it: Apps Script is simply slower than a server. |
