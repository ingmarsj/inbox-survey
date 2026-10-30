# Inbox survey

A minimalist, mobile-first survey for Inbox.lv user events. Respondents tap "Sākt" ("Start"), answer one question at a time, and every answer is stored in SQLite. The survey itself is written in Latvian.

**Live demo:** https://ingmarsj.github.io/inbox-survey/ (answers are not stored; see [GitHub Pages demo](#github-pages-demo)).

## Features

- One question per screen, with a progress counter, a "Back" button and keyboard shortcuts (digits pick an answer, Enter continues).
- Question types: single choice (buttons or dropdown), multiple choice, scale (e.g. 1–5 or NPS 0–10) and free text.
- Answers are saved after every question, so a half-finished survey is not lost. Reloading resumes where the respondent stopped, and flaky Wi-Fi is handled by retrying in the background.
- Anonymous: only a random submission ID is stored, no personal data.
- Live results page and CSV export, protected by a secret token.
- Light and dark theme, following the Inbox.lv look and feel; split layout on desktop, single column on phones.
- No runtime dependencies: only Node.js (built-in `node:sqlite`, `node:http` and `node:test`).

## Quick start

Requires Node.js 22.13 or newer.

```bash
npm start
```

The server prints three links:

| Link | Purpose |
| --- | --- |
| `http://localhost:3000/` | The survey. Show a QR code for this address on the big screen. |
| `http://localhost:3000/results?token=…` | Live results, refreshed every 5 seconds. |
| `http://localhost:3000/api/export.csv?token=…` | CSV export of all answers. |

The results token is generated once and stored in the database, so the link survives restarts. To use your own, set `ADMIN_TOKEN`.

Open `/?reset` to forget the saved progress in the current browser and start from scratch.

### Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/survey.db` | SQLite database file (created on first start) |
| `ADMIN_TOKEN` | generated | Secret for the results page and the CSV export |

To let phones reach the survey, the server must be reachable from the network (a public host or a tunnel); on `localhost` it only works on the same computer.

## Changing the questions

Everything lives in [`questions.json`](questions.json); restart the server after editing it. The server validates every answer against this file and refuses to start if the file is broken.

- Types: `single`, `multi`, `scale` (`min` / `max`) and `text` (`maxLength`, `multiline`).
- `"display": "dropdown"` renders a `single` question as a dropdown.
- `"required": true` means the respondent cannot continue without an answer.
- Do not rename a question `id` once answers have been collected: answers are linked by `id`.

## Data

`data/survey.db` is a SQLite database with three tables:

- `submissions`: one row per respondent (random UUID, created and completed timestamps).
- `answers`: one row per answer (`submission_id`, `question_id`, JSON `value`).
- `meta`: the generated results token.

The `data/` folder is git-ignored. Back it up before an event if the answers matter.

## Tests

```bash
npm test
```

The suite starts real servers on random ports with in-memory or temporary databases. It covers validation for every question type, the full respondent journey, persistence across restarts, results and CSV, access control, path traversal, the in-browser demo API and the static demo build.

## GitHub Pages demo

GitHub Pages can only host static files, so it cannot run the Node server or SQLite. The Pages site is therefore a **demo**: it looks and behaves like the survey, but answers stay in the visitor's own browser (`localStorage`) and are **not stored anywhere**. A "Demo versija" badge in the header says so, and there is no results page.

How it works: `npm run build:pages` copies `public/` and `questions.json` into `dist/` and writes a `config.js` that switches the front end to the in-browser API in [`public/demo-api.js`](public/demo-api.js). That API uses the same validation as the server ([`public/validate.js`](public/validate.js)). The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests, builds the demo and deploys it on every push to `main`.

To collect real answers, run the server (`npm start`) on a host that supports Node.js.

## Project layout

```
server.js            HTTP server and API
db.js                SQLite access
questions.js         Loads and checks questions.json
results.js           Aggregation and CSV export
questions.json       The survey (Latvian)
public/              Front end (plain HTML, CSS and ES modules, no build step)
  validate.js        Answer validation shared by the server and the demo
  demo-api.js        In-browser API used by the GitHub Pages demo
scripts/             build-pages.mjs creates the static demo
test/                node:test suites
```

## Notes

- The Inbox.lv logos in `public/img/` are Inbox.lv brand assets and are not covered by any open-source licence.
- No licence has been chosen for the code yet; add a `LICENSE` file if you want others to be able to reuse it.
