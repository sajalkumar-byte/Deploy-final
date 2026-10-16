# Infrastructure & Support – Technology Task and Project Tracker

A single-page tracker for projects, recurring work and one-off tasks.
Plain HTML, CSS and JavaScript on Bootstrap 5.3 – no build step, no server required.

## Run it

* Open `index.html` directly, or
* serve the folder (for example `python -m http.server 8000`) and open `http://localhost:8000/`.

Everything needed is in the repository, including Bootstrap and the export libraries in `vendor/`, so it also works offline.

## Features

* Overview dashboard with KPIs, status pies, workload and overdue lists
* Separate Projects, Recurring and Tasks pages with search, status, priority and person filters
* Team page with per-member workload
* Export of the current page (or all data from the Overview) to PDF, Excel and print
* Three themes – Light, Dark and Ocean – remembered per browser
* Sign-in with four roles: Super admin (manages users and roles), Admin, Superuser (edits tasks only) and Viewer
* Works standalone with data kept in the browser, or on claude.ai with a shared live database

## Code layout (MVP)

| Path | Role |
|---|---|
| `js/model.js` | data, business rules, permissions, storage adapters (cloud / local) |
| `js/view.js` | rendering only: templates, modals, toasts, gate screens |
| `js/presenter.js` | user actions, navigation, filters, sign-in, user management, boot |
| `js/export.js` | PDF / Excel / print service |
| `css/style.css` | brand theming, themes and animation on top of Bootstrap |
| `vendor/` | Bootstrap 5.3.3, SheetJS, jsPDF, jsPDF-AutoTable |
| `js/gsheet.js` | the Google Sheet backend adapter, including chat over polling |
| `js/api.js` | the Node.js backend adapter |
| `js/chat.js` | one-to-one chat: a socket where there is one, polling where there is not |
| `backend/` | the Node.js server, split the same way: `src/model`, `src/view`, `src/presenter` |
| `google-apps-script/` | the same backend as an Apps Script, with the spreadsheet as its database |

## Accounts

Sign-in accounts are shipped in `config/users.js`, so every device shows the same sign-in page.
The default super admin is `admin@tracker.com` with password `Admin@1234` – change it after the first sign-in.

The Super admin adds colleagues from the **Users** button and assigns their roles. On static hosting such as GitHub Pages
those changes live in that browser only until published: click **Download users.js** in the Users dialog, replace
`config/users.js` in the repository with the downloaded file, and push. Every device then gets the updated accounts.

If `config/users.js` is empty, the first visitor is asked to create the Super admin instead.
