import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, validAnswers, config, TOKEN, rawGet } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fills in a whole submission and completes it. */
async function submitAll(s, overrides = {}) {
  const id = await s.newSubmission();
  const answers = validAnswers(overrides);
  for (const [qid, value] of Object.entries(answers)) {
    const res = await s.answer(id, qid, value);
    assert.equal(res.status, 200, `${qid}: ${res.text}`);
  }
  const done = await s.call('POST', `/api/submissions/${id}/complete`);
  assert.equal(done.status, 200, done.text);
  return id;
}

test('GET /api/questions serves the config used for validation', async () => {
  const s = await startServer();
  try {
    const res = await s.call('GET', '/api/questions');
    assert.equal(res.status, 200);
    assert.equal(res.json.questions.length, config.questions.length);
    assert.equal(res.json.intro.button, 'Sākt');
    assert.match(res.headers.get('content-type'), /application\/json/);
  } finally {
    await s.stop();
  }
});

test('a respondent can go through the whole survey and everything lands in SQLite', async () => {
  const s = await startServer();
  try {
    const id = await submitAll(s);
    assert.match(id, UUID);

    const got = await s.call('GET', `/api/submissions/${id}`);
    assert.equal(got.json.completed, true);
    assert.deepEqual(got.json.answers, validAnswers());

    // check the database directly, not just through the API
    const sub = s.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    assert.ok(sub.completed_at);
    const rows = s.db.prepare('SELECT COUNT(*) AS n FROM answers WHERE submission_id = ?').get(id);
    assert.equal(rows.n, Object.keys(validAnswers()).length);
    const years = s.db.prepare("SELECT value FROM answers WHERE submission_id = ? AND question_id = 'years_using'").get(id);
    assert.equal(JSON.parse(years.value), 'under_1');
  } finally {
    await s.stop();
  }
});

test('progress is saved as the respondent goes, so reloading resumes', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    await s.answer(id, 'years_using', '2');
    await s.answer(id, 'recommend', 4);
    const got = await s.call('GET', `/api/submissions/${id}`);
    assert.equal(got.json.completed, false);
    assert.deepEqual(got.json.answers, { years_using: '2', recommend: 4 });
  } finally {
    await s.stop();
  }
});

test('changing an answer overwrites it instead of adding a row', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    await s.answer(id, 'years_using', '1');
    await s.answer(id, 'years_using', '2');
    const rows = s.db.prepare("SELECT value FROM answers WHERE submission_id = ? AND question_id = 'years_using'").all(id);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].value), '2');
  } finally {
    await s.stop();
  }
});

test('an optional text answer can be cleared, a required one cannot', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    await s.answer(id, 'pain_point', 'Lēns');
    assert.equal((await s.answer(id, 'pain_point', '')).status, 200);
    assert.equal((await s.call('GET', `/api/submissions/${id}`)).json.answers.pain_point, undefined);

    await s.answer(id, 'years_using', '3');
    const res = await s.answer(id, 'years_using', null);
    assert.equal(res.status, 400);
    assert.equal((await s.call('GET', `/api/submissions/${id}`)).json.answers.years_using, '3');
  } finally {
    await s.stop();
  }
});

test('rejects invalid answers with 400 and stores nothing', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    const cases = [
      ['years_using', '0'],
      ['years_using', '100'],
      ['years_using', 3],
      ['years_using', ''],
      ['feedback_channel', 'martian'],
      ['feedback_channel', 7],
      ['news_channel', 'email'],
      ['news_channel', ['email', 'nope']],
      ['recommend', 6],
      ['recommend', 0],
      ['recommend', '4'],
      ['feedback_ease', 3],
      ['feedback_ease', 'martian'],
      ['age_group', 'ancient'],
      ['one_word', 'x'.repeat(41)],
      ['pain_point', 'x'.repeat(1001)],
      ['pain_point', { a: 1 }],
    ];
    for (const [qid, value] of cases) {
      const res = await s.answer(id, qid, value);
      assert.equal(res.status, 400, `${qid}=${JSON.stringify(value).slice(0, 30)}`);
      assert.ok(res.json.error);
    }
    assert.deepEqual((await s.call('GET', `/api/submissions/${id}`)).json.answers, {});
  } finally {
    await s.stop();
  }
});

test('unknown ids, bad JSON and oversized bodies are handled', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    assert.equal((await s.answer(id, 'no_such_question', 'x')).status, 404);
    assert.equal((await s.call('GET', '/api/submissions/not-a-uuid')).status, 404);
    assert.equal((await s.call('GET', '/api/submissions/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await s.answer('00000000-0000-4000-8000-000000000000', 'years_using', '3')).status, 404);
    assert.equal((await s.call('PUT', `/api/submissions/${id}/answers/years_using`, '{not json')).status, 400);
    assert.equal((await s.call('PUT', `/api/submissions/${id}/answers/pain_point`, { value: 'x'.repeat(40_000) })).status, 413);
    assert.equal((await s.call('GET', '/api/nope')).status, 404);
  } finally {
    await s.stop();
  }
});

test('cannot complete until every required question is answered', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    await s.answer(id, 'years_using', '3');
    const res = await s.call('POST', `/api/submissions/${id}/complete`);
    assert.equal(res.status, 422);
    const required = config.questions.filter((q) => q.required).map((q) => q.id);
    assert.deepEqual(res.json.missing, required.filter((qid) => qid !== 'years_using'));
    assert.equal(s.db.prepare('SELECT completed_at FROM submissions WHERE id = ?').get(id).completed_at, null);
  } finally {
    await s.stop();
  }
});

test('optional questions may stay empty and the survey still completes', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    for (const q of config.questions.filter((q) => q.required)) await s.answer(id, q.id, validAnswers()[q.id]);
    assert.equal((await s.call('POST', `/api/submissions/${id}/complete`)).status, 200);
  } finally {
    await s.stop();
  }
});

test('a completed submission is locked and completing twice is harmless', async () => {
  const s = await startServer();
  try {
    const id = await submitAll(s);
    const first = s.db.prepare('SELECT completed_at FROM submissions WHERE id = ?').get(id).completed_at;
    assert.equal((await s.answer(id, 'years_using', '2')).status, 409);
    assert.equal((await s.call('POST', `/api/submissions/${id}/complete`)).status, 200);
    assert.equal(s.db.prepare('SELECT completed_at FROM submissions WHERE id = ?').get(id).completed_at, first);
    assert.equal((await s.call('GET', `/api/submissions/${id}`)).json.answers.years_using, 'under_1');
  } finally {
    await s.stop();
  }
});

test('concurrent respondents do not mix up answers', async () => {
  const s = await startServer();
  try {
    const ids = await Promise.all(Array.from({ length: 30 }, () => s.newSubmission()));
    await Promise.all(ids.map((id, i) => s.answer(id, 'recommend', 1 + (i % 5))));
    for (const [i, id] of ids.entries()) {
      assert.equal((await s.call('GET', `/api/submissions/${id}`)).json.answers.recommend, 1 + (i % 5));
    }
  } finally {
    await s.stop();
  }
});

/* ---------- results ---------- */

test('results need the admin token', async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call('GET', '/api/results')).status, 401);
    assert.equal((await s.call('GET', '/api/results?token=wrong')).status, 401);
    assert.equal((await s.call('GET', '/api/export.csv')).status, 401);
    assert.equal((await s.call('GET', `/api/results?token=${TOKEN}`)).status, 200);
    assert.equal((await s.call('GET', '/api/results', undefined, { 'x-admin-token': TOKEN })).status, 200);
  } finally {
    await s.stop();
  }
});

test('results aggregate counts, averages and texts', async () => {
  const s = await startServer();
  try {
    // three finished respondents and one who stopped halfway
    await submitAll(s, { years_using: '1', recommend: 5, feedback_channel: ['email_survey'], news_channel: ['email'], satisfaction: 5, one_word: 'ātrs' });
    await submitAll(s, { years_using: '2', recommend: 4, feedback_channel: ['support_team'], news_channel: ['email', 'in_app'], satisfaction: 4, one_word: 'ērts' });
    await submitAll(s, { years_using: '10_plus', recommend: 1, feedback_channel: ['mobile_app_form'], news_channel: ['social'], satisfaction: 2, one_word: 'lēns' });
    const partial = await s.newSubmission();
    await s.answer(partial, 'years_using', '2');
    await s.answer(partial, 'recommend', 3);

    const all = (await s.call('GET', `/api/results?token=${TOKEN}`)).json;
    assert.deepEqual(all.totals, { started: 4, completed: 3 });
    const q = (id) => all.questions.find((x) => x.id === id);

    const channel = q('feedback_channel');
    assert.equal(channel.answered, 3);
    assert.deepEqual(
      Object.fromEntries(channel.options.filter((o) => o.count).map((o) => [o.value, o.count])),
      { email_survey: 1, support_team: 1, mobile_app_form: 1 },
    );

    const news = q('news_channel');
    assert.equal(news.answered, 3);
    assert.equal(news.options.find((o) => o.value === 'email').count, 2);
    assert.equal(news.options.find((o) => o.value === 'in_app').count, 1);

    const rec = q('recommend');
    assert.equal(rec.answered, 4);
    assert.equal(rec.average, (5 + 4 + 1 + 3) / 4);
    assert.equal(rec.distribution.length, 5);
    assert.equal(rec.distribution.find((d) => d.value === 4).count, 1);
    assert.equal(rec.nps, undefined, 'no NPS maths on a 1-5 scale');

    const ease = q('feedback_ease');
    assert.equal(ease.options.find((o) => o.value === 'no_need').label, 'Nesaskatu nepieciešamību');

    const years = q('years_using');
    assert.equal(years.answered, 4);
    assert.deepEqual(
      Object.fromEntries(years.options.filter((o) => o.count).map((o) => [o.value, o.count])),
      { 1: 1, 2: 2, '10_plus': 1 },
    );

    assert.equal(q('satisfaction').average, (5 + 4 + 2) / 3);
    assert.deepEqual(q('one_word').texts.map((x) => x.text).sort(), ['lēns', 'ātrs', 'ērts'].sort());
  } finally {
    await s.stop();
  }
});

test('results for an empty database do not crash', async () => {
  const s = await startServer();
  try {
    const res = (await s.call('GET', `/api/results?token=${TOKEN}`)).json;
    assert.deepEqual(res.totals, { started: 0, completed: 0 });
    const rec = res.questions.find((q) => q.id === 'recommend');
    assert.equal(rec.average, null);
    assert.deepEqual(rec.distribution.map((d) => d.count), [0, 0, 0, 0, 0]);
  } finally {
    await s.stop();
  }
});

test('CSV export has a header, UTF-8 BOM, proper quoting and blocks formula injection', async () => {
  const s = await startServer();
  try {
    await submitAll(s, { years_using: '3', pain_point: '=HYPERLINK("http://x")', anything_else: 'rinda 1\nrinda 2, ar komatu', one_word: 'ātrs' });
    const res = await s.call('GET', `/api/export.csv?token=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.ok(res.text.startsWith('﻿submission_id,created_at,completed_at,age_group,'));
    const header = res.text.slice(1).split('\r\n')[0].split(',');
    assert.deepEqual(header.slice(3), config.questions.map((q) => q.id));
    assert.ok(res.text.includes('ātrs'));
    assert.ok(res.text.includes(`"'=HYPERLINK(""http://x"")"`), 'formula is neutralised and quotes are escaped');
    assert.ok(res.text.includes('"rinda 1\nrinda 2, ar komatu"'));
    assert.ok(res.text.includes('email|in_app'), 'multi answers are joined with |');
  } finally {
    await s.stop();
  }
});

/* ---------- persistence ---------- */

test('data and the admin token survive a server restart (file database)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'survey-'));
  const dbPath = path.join(dir, 'nested', 'survey.db');
  delete process.env.ADMIN_TOKEN;
  let first;
  let second;
  try {
    first = await startServer({ dbPath, adminToken: null });
    const token = first.adminToken;
    assert.ok(token.length >= 20, 'a random token is generated');
    const id = await submitAll(first, { years_using: '10_plus' });
    await first.stop();
    first = null;

    second = await startServer({ dbPath, adminToken: null });
    assert.equal(second.adminToken, token, 'same token after restart');
    const got = await second.call('GET', `/api/submissions/${id}`);
    assert.equal(got.json.completed, true);
    assert.equal(got.json.answers.years_using, '10_plus');
    assert.equal((await second.call('GET', `/api/results?token=${token}`)).json.totals.completed, 1);
  } finally {
    await first?.stop();
    await second?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- static files ---------- */

test('serves the pages and refuses to leave the public folder', async () => {
  const s = await startServer();
  try {
    const index = await s.call('GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.text, /<script src="app\.js"/);
    assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(index.text, /<a class="logo-link" href=".\/"/, 'the logo links to the first page');

    assert.equal((await s.call('GET', '/app.js')).status, 200);
    assert.match((await s.call('GET', '/style.css')).headers.get('content-type'), /text\/css/);
    const results = await s.call('GET', '/results');
    assert.equal(results.status, 200);
    assert.match(results.text, /results\.js/);

    // both pages show the Inbox logo, with a white variant for dark mode
    for (const page of [index.text, results.text]) {
      assert.match(page, /src="img\/inbox\.png"/);
      assert.match(page, /srcset="img\/inbox-white\.png"/);
    }
    for (const logo of ['/img/inbox.png', '/img/inbox-white.png']) {
      const res = await fetch(s.base + logo);
      assert.equal(res.status, 200, logo);
      assert.equal(res.headers.get('content-type'), 'image/png', logo);
      assert.deepEqual([...new Uint8Array(await res.arrayBuffer()).slice(1, 4)], [0x50, 0x4e, 0x47], `${logo} is a PNG`);
    }

    assert.equal((await s.call('GET', '/missing.html')).status, 404);
    for (const evil of ['/..%2fserver.js', '/%2e%2e/server.js', '/..%2f..%2fpackage.json', '/data/survey.db']) {
      const res = await rawGet(s.base, evil);
      assert.equal(res.status, 404, evil);
      assert.ok(!res.text.includes('createApp'), evil);
    }
    assert.equal((await s.call('POST', '/index.html', {})).status, 405);
  } finally {
    await s.stop();
  }
});

/* ---------- the short path for people who do not use Inbox.lv ---------- */

test('a non-user can finish after the demographics and the first question, or add the reason and the free-text answers', async () => {
  const s = await startServer();
  try {
    const quick = await s.newSubmission();
    assert.equal((await s.answer(quick, 'age_group', '25_34')).status, 200);
    assert.equal((await s.answer(quick, 'gender', 'no_answer')).status, 200);
    assert.equal((await s.answer(quick, 'years_using', 'not_using')).status, 200);
    assert.equal((await s.call('POST', `/api/submissions/${quick}/complete`)).status, 200);

    const full = await submitAll(s, { years_using: 'not_using' });
    const answers = (await s.call('GET', `/api/submissions/${full}`)).json.answers;
    assert.deepEqual(Object.keys(answers).sort(), ['age_group', 'anything_else', 'gender', 'not_using_reason', 'one_word', 'years_using']);
  } finally {
    await s.stop();
  }
});

test('answers to questions that are off the respondent path are rejected and not stored', async () => {
  const s = await startServer();
  try {
    const nonUser = await s.newSubmission();
    await s.answer(nonUser, 'years_using', 'not_using');
    for (const [qid, value] of [['news_channel', ['email']], ['recommend', 4], ['pain_point', 'Slow']]) {
      assert.equal((await s.answer(nonUser, qid, value)).status, 400, qid);
    }

    const user = await s.newSubmission();
    await s.answer(user, 'years_using', '2');
    assert.equal((await s.answer(user, 'not_using_reason', 'Because')).status, 400);
    assert.equal((await s.answer(await s.newSubmission(), 'not_using_reason', 'Because')).status, 400, 'hidden until the first answer says so');

    assert.deepEqual((await s.call('GET', `/api/submissions/${nonUser}`)).json.answers, { years_using: 'not_using' });
    assert.deepEqual((await s.call('GET', `/api/submissions/${user}`)).json.answers, { years_using: '2' });
  } finally {
    await s.stop();
  }
});

test('changing the first answer drops the answers that no longer belong to the new path', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    const answers = async () => (await s.call('GET', `/api/submissions/${id}`)).json.answers;

    await s.answer(id, 'years_using', '2');
    await s.answer(id, 'news_channel', ['email']);
    await s.answer(id, 'recommend', 4);
    await s.answer(id, 'one_word', 'ātrs');

    await s.answer(id, 'years_using', 'not_using'); // user -> non-user
    assert.deepEqual(await answers(), { years_using: 'not_using', one_word: 'ātrs' });

    await s.answer(id, 'not_using_reason', 'Use another mailbox');
    assert.equal((await answers()).not_using_reason, 'Use another mailbox');

    await s.answer(id, 'years_using', '3'); // non-user -> user
    assert.deepEqual(await answers(), { years_using: '3', one_word: 'ātrs' });

    // the database agrees with the API
    const rows = s.db.prepare('SELECT question_id FROM answers WHERE submission_id = ? ORDER BY question_id').all(id);
    assert.deepEqual(rows.map((r) => r.question_id), ['one_word', 'years_using']);
  } finally {
    await s.stop();
  }
});

test('a user still has to answer every regular required question; the reason question is never required', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    await s.answer(id, 'years_using', '4');
    const res = await s.call('POST', `/api/submissions/${id}/complete`);
    assert.equal(res.status, 422);
    assert.deepEqual(res.json.missing, ['age_group', 'gender', 'news_channel', 'news_frequency', 'feedback_channel', 'feedback_ease', 'satisfaction', 'recommend']);
  } finally {
    await s.stop();
  }
});

test('results keep the "why not" answers apart from the users answers', async () => {
  const s = await startServer();
  try {
    await submitAll(s, { years_using: 'not_using', not_using_reason: 'No need' });
    await submitAll(s, { years_using: '2', recommend: 4 });
    const results = (await s.call('GET', `/api/results?token=${TOKEN}`)).json;
    const q = (id) => results.questions.find((x) => x.id === id);
    assert.deepEqual(q('not_using_reason').texts, [{ text: 'No need' }]);
    assert.equal(q('recommend').answered, 1, 'the non-user was never asked');
    assert.equal(q('years_using').options.find((o) => o.value === 'not_using').count, 1);
    assert.deepEqual(results.totals, { started: 2, completed: 2 });
  } finally {
    await s.stop();
  }
});

/* ---------- "Cits": an option with a text box ---------- */

test('"Cits" in the news question takes a write-in text, which only exists while "Cits" is selected', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    const answers = async () => (await s.call('GET', `/api/submissions/${id}`)).json.answers;

    await s.answer(id, 'years_using', '2');
    // the text box is not part of the path until "Cits" is chosen
    assert.equal((await s.answer(id, 'news_channel_other', 'My blog')).status, 400);
    await s.answer(id, 'news_channel', ['email']);
    assert.equal((await s.answer(id, 'news_channel_other', 'My blog')).status, 400);

    await s.answer(id, 'news_channel', ['email', 'other']);
    assert.equal((await s.answer(id, 'news_channel_other', '  My blog  ')).status, 200);
    assert.equal((await answers()).news_channel_other, 'My blog', 'trimmed');
    assert.equal((await s.answer(id, 'news_channel_other', 'x'.repeat(201))).status, 400);

    await s.answer(id, 'news_channel', ['email']); // unselecting "Cits" removes the text
    assert.equal((await answers()).news_channel_other, undefined);
    assert.deepEqual((await answers()).news_channel, ['email']);
  } finally {
    await s.stop();
  }
});

test('the write-in text is also removed when a non-user switch hides the whole news question', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    await s.answer(id, 'years_using', '3');
    await s.answer(id, 'news_channel', ['other']);
    await s.answer(id, 'news_channel_other', 'Telegram');
    await s.answer(id, 'years_using', 'not_using');
    const answers = (await s.call('GET', `/api/submissions/${id}`)).json.answers;
    assert.deepEqual(answers, { years_using: 'not_using' }, 'the news answer and its text are gone, not just the first');
    assert.deepEqual(
      s.db.prepare('SELECT question_id FROM answers WHERE submission_id = ?').all(id).map((r) => r.question_id),
      ['years_using'],
    );
  } finally {
    await s.stop();
  }
});

test('feedback channels accept several answers, and the write-in text shows up in the results', async () => {
  const s = await startServer();
  try {
    await submitAll(s, { years_using: '2', feedback_channel: ['email_survey', 'social'], news_channel: ['other'], news_channel_other: 'Telegram' });
    await submitAll(s, { years_using: '2', feedback_channel: ['social'] });
    const results = (await s.call('GET', `/api/results?token=${TOKEN}`)).json;
    const q = (id) => results.questions.find((x) => x.id === id);
    const counts = Object.fromEntries(q('feedback_channel').options.map((o) => [o.value, o.count]));
    assert.deepEqual(counts, { email_survey: 1, support_team: 0, mobile_app_form: 0, social: 2 });
    assert.deepEqual(q('news_channel_other').texts, [{ text: 'Telegram' }]);
  } finally {
    await s.stop();
  }
});
