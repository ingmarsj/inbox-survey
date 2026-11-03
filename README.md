# Inbox survey

A minimalist, mobile-first survey for Inbox.lv user events. Respondents tap "Sākt" ("Start"), answer one question at a time, and every answer is stored. The survey itself is written in Latvian.

The same front end runs against three backends:

| Backend | Where answers go | Used for |
| --- | --- | --- |
| **Supabase** | Postgres tables `survey_*` in the same Supabase project as the theme vote | Production: https://why.inbokss.com/inbox-survey/ |
| **Node server** | SQLite file (`npm start`) | Running it yourself, development, offline events |
| **Demo** | Nowhere (the visitor's browser only) | https://ingmarsj.github.io/inbox-survey/ |

## Features

- One question per screen, with a progress counter, a "Back" button and keyboard shortcuts (digits pick an answer, Enter continues).
- Question types: single choice (buttons or dropdown), multiple choice, scale (e.g. 1–5) and free text, with optional conditional paths (for example a short path for non-users).
- Answers are saved after every question, so a half-finished survey is not lost. Reloading resumes where the respondent stopped, and flaky Wi-Fi is handled by retrying in the background.
- Anonymous: only a random submission ID is stored, no personal data.
- Live results page and CSV export, protected by a secret token.
- Light and dark theme, following the Inbox.lv look and feel; split layout on desktop, single column on phones.
- No runtime dependencies. The only dev dependency is [PGlite](https://pglite.dev/), an in-process Postgres used to test the SQL.

## Production: Supabase + why.inbokss.com

`why.inbokss.com` is a static GitHub Pages site (repository `INBOKSS/why`), and Supabase cannot serve web pages, so the survey is split in two:

- **Pages:** the folder `inbox-survey/` inside the `INBOKSS/why` repository, served at `https://why.inbokss.com/inbox-survey/`.
- **Data:** tables and functions in the Supabase project `webmail-themes`, next to the theme vote. Everything is prefixed `survey_`; nothing existing is touched.

The browser holds only the project URL and the **publishable** key (already public on the theme vote page). The tables have row level security and no privileges for that key, so the page can only call these functions:

| Function | Purpose |
| --- | --- |
| `survey_get_config()` | The survey definition (the content of `questions.json`) |
| `survey_create_submission()` | Start an anonymous submission, returns its random id |
| `survey_get_submission(id)` | Resume: answers given so far |
| `survey_save_answer(id, question, value)` | Validate and save one answer; drops answers that no longer belong to the respondent's path |
| `survey_complete(id)` | Finish, or list the required questions that are still missing |
| `survey_export(token)` | Everything for the results page. Needs the secret results token |

Validation happens inside Postgres ([`supabase/schema.sql`](supabase/schema.sql)) and follows exactly the same rules as [`public/validate.js`](public/validate.js); the tests run the same cases through both and compare.

### Setting it up (once)

1. In the Supabase SQL editor run [`supabase/schema.sql`](supabase/schema.sql). It is safe to run again.
2. Run [`supabase/seed-questions.sql`](supabase/seed-questions.sql). It stores `questions.json` in the database. Run it again after every change to `questions.json` (regenerate it with `npm run build:supabase`).
3. Create the secret for the results page and store only its hash, so the secret itself is never in the database or in the SQL editor history:

   ```bash
   node -e "const c=require('crypto');const t=c.randomBytes(24).toString('base64url');console.log('secret:',t);console.log('hash:  ',c.createHash('sha256').update(t).digest('hex'))"
   ```

   ```sql
   insert into public.survey_meta (key, value) values ('admin_token_sha256', '<the hash>')
   on conflict (key) do update set value = excluded.value;
   ```

   Results are then at `https://why.inbokss.com/inbox-survey/results.html#token=<the secret>`. Keeping the secret in the `#` part of the URL means it is never sent to any server. Keep the secret somewhere safe: it cannot be read back from the database (run the two steps again to replace it).

### Publishing the pages

```bash
npm run build:why
```

writes `dist-why/inbox-survey/`. Copy that folder into the root of the `INBOKSS/why` repository and commit it; GitHub Pages publishes it. `supabase/project.json` holds the (public) project URL and publishable key that get written into the page's `config.js`. The build refuses anything that looks like a secret key.

## Running it yourself (Node + SQLite)

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

The results token is generated once and stored in the database, so the link survives restarts. To use your own, set `ADMIN_TOKEN`. Open `/?reset` to forget the saved progress in the current browser.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/survey.db` | SQLite database file (created on first start) |
| `ADMIN_TOKEN` | generated | Secret for the results page and the CSV export |

To let phones reach the survey, the server must be reachable from the network (a public host or a tunnel); on `localhost` it only works on the same computer. The SQLite database has three tables: `submissions`, `answers` and `meta`. The `data/` folder is git-ignored.

## Changing the questions

Everything lives in [`questions.json`](questions.json).

- Types: `single`, `multi`, `scale` (`min` / `max`) and `text` (`maxLength`, `multiline`).
- `"display": "dropdown"` renders a `single` question as a dropdown.
- `"required": true` means the respondent cannot continue without an answer.
- `"visibleIf": { "question": "years_using", "equals": "not_using" }` (or `"notEquals"`) shows a question only on some paths. It may refer to an earlier single-choice question that is itself always shown. The survey uses this to give people who do not use Inbox.lv a short path (why not, associations, free comment). Answers that stop belonging to the path when someone changes an earlier answer are dropped, and hidden questions are never required.
- Do not rename a question `id` once answers have been collected: answers are linked by `id`.

After editing: restart the Node server, **and** for Supabase run `npm run build:supabase` and execute the regenerated `supabase/seed-questions.sql`, then publish the pages again if the front end changed. A test fails if the checked-in seed is out of date.

## Tests

```bash
npm install
npm test
```

The suite starts real servers on random ports with in-memory or temporary databases, and runs the Supabase SQL in an in-process Postgres. It covers validation for every question type (SQL against JavaScript), the full respondent journey, persistence across restarts, results and CSV, access control (including that the public key cannot touch the tables), path traversal, the in-browser demo API, the Supabase client against the real SQL functions, and both static builds.

## GitHub Pages demo

GitHub Pages can only host static files, so [the demo](https://ingmarsj.github.io/inbox-survey/) cannot store answers: they stay in the visitor's own browser (`localStorage`). A "Demo versija" badge in the header says so, and there is no results page. `npm run build:pages` builds it, and the workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests and deploys it on every push to `main`.

## Project layout

```
server.js            HTTP server and API (SQLite)
db.js                SQLite access
questions.js         Loads and checks questions.json
results.js           Results and CSV from SQLite
questions.json       The survey (Latvian)
public/              Front end (plain HTML, CSS and ES modules, no build step)
  validate.js        Answer validation and path rules, shared by every backend
  aggregate.js       Results and CSV maths, shared by the server and the browser
  supabase-api.js    Browser client for the Supabase functions
  demo-api.js        In-browser fake backend for the GitHub Pages demo
  config.js          Which backend the page talks to
supabase/            schema.sql, generated seed-questions.sql, project.json (public values)
scripts/             build-why.mjs, build-pages.mjs, build-supabase-sql.mjs
test/                node:test suites
```

## Notes

- The Inbox.lv logos in `public/img/` are Inbox.lv brand assets and are not covered by any open-source licence.
- No licence has been chosen for the code yet; add a `LICENSE` file if you want others to be able to reuse it.
