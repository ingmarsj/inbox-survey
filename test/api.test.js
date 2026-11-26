import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, validAnswers, config, TOKEN, rawGet } from './helpers.js';
import { isQuestionVisible } from '../questions.js';

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
    assert.equal(JSON.parse(years.value), '0_1');
  } finally {
    await s.stop();
  }
});

test('progress is saved as the respondent goes, so reloading resumes', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    await s.answer(id, 'years_using', '2_4');
    await s.answer(id, 'recommend', 4);
    const got = await s.call('GET', `/api/submissions/${id}`);
    assert.equal(got.json.completed, false);
    assert.deepEqual(got.json.answers, { years_using: '2_4', recommend: 4 });
  } finally {
    await s.stop();
  }
});

test('changing an answer overwrites it instead of adding a row', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    await s.answer(id, 'years_using', '0_1');
    await s.answer(id, 'years_using', '2_4');
    const rows = s.db.prepare("SELECT value FROM answers WHERE submission_id = ? AND question_id = 'years_using'").all(id);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].value), '2_4');
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

    await s.answer(id, 'years_using', '2_4');
    const res = await s.answer(id, 'years_using', null);
    assert.equal(res.status, 400);
    assert.equal((await s.call('GET', `/api/submissions/${id}`)).json.answers.years_using, '2_4');
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
      ['city', 'mars'],
      ['email_frequency', 'hourly'],
      ['inbox_products', 'mobile_app'],
      ['inbox_products', ['mobile_app', 'nope']],
      ['premium_used', 'maybe'],
      ['considered_leaving', 'maybe'],
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
    assert.equal((await s.answer('00000000-0000-4000-8000-000000000000', 'years_using', '2_4')).status, 404);
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
    await s.answer(id, 'years_using', '2_4');
    const res = await s.call('POST', `/api/submissions/${id}/complete`);
    assert.equal(res.status, 422);
    // required questions that are on the respondent's path (the support rating only exists for people who contacted support)
    const required = config.questions.filter((q) => q.required && isQuestionVisible(q, { years_using: '2_4' })).map((q) => q.id);
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
    assert.equal((await s.answer(id, 'years_using', '2_4')).status, 409);
    assert.equal((await s.call('POST', `/api/submissions/${id}/complete`)).status, 200);
    assert.equal(s.db.prepare('SELECT completed_at FROM submissions WHERE id = ?').get(id).completed_at, first);
    assert.equal((await s.call('GET', `/api/submissions/${id}`)).json.answers.years_using, '0_1');
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
    await submitAll(s, { years_using: '0_1', recommend: 5, feedback_channel: ['email_survey'], news_channel: ['email'], satisfaction: 5, pain_point: 'ātrs' });
    await submitAll(s, { years_using: '2_4', recommend: 4, feedback_channel: ['support_team'], news_channel: ['email', 'in_app'], satisfaction: 4, pain_point: 'ērts' });
    await submitAll(s, { years_using: '10_plus', recommend: 1, feedback_channel: ['mobile_app_form'], news_channel: ['social'], satisfaction: 2, pain_point: 'lēns' });
    const partial = await s.newSubmission();
    await s.answer(partial, 'years_using', '2_4');
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
      { '0_1': 1, '2_4': 2, '10_plus': 1 },
    );

    assert.equal(q('satisfaction').average, (5 + 4 + 2) / 3);
    assert.deepEqual(q('pain_point').texts.map((x) => x.text).sort(), ['lēns', 'ātrs', 'ērts'].sort());
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
    await submitAll(s, { years_using: '2_4', pain_point: '=HYPERLINK("http://x")', anything_else: 'rinda 1\nrinda 2, ar komatu' });
    const res = await s.call('GET', `/api/export.csv?token=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.ok(res.text.startsWith('﻿submission_id,created_at,completed_at,age_group,'));
    const header = res.text.slice(1).split('\r\n')[0].split(',');
    assert.deepEqual(header.slice(3), [...config.questions.map((q) => q.id), ...config.archived.map((q) => q.id)], 'live questions first, removed ones last');
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

/* ---------- follow-up questions ---------- */

test('only people who contacted support are asked to rate it', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    const answers = async () => (await s.call('GET', `/api/submissions/${id}`)).json.answers;

    // hidden until the answer to the first question says so
    assert.equal((await s.answer(id, 'support_rating', 4)).status, 400);
    await s.answer(id, 'support_tried', 'knew');
    assert.equal((await s.answer(id, 'support_rating', 4)).status, 400);

    await s.answer(id, 'support_tried', 'tried');
    assert.equal((await s.answer(id, 'support_rating', 4)).status, 200);
    assert.equal((await s.answer(id, 'support_rating', 6)).status, 400, 'still a 1-5 scale');
    assert.deepEqual(await answers(), { support_tried: 'tried', support_rating: 4 });
  } finally {
    await s.stop();
  }
});

test('changing the support answer drops the follow-up answers that no longer belong', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    const answers = async () => (await s.call('GET', `/api/submissions/${id}`)).json.answers;
    await s.answer(id, 'years_using', '2_4');
    await s.answer(id, 'support_tried', 'tried');
    await s.answer(id, 'support_rating', 5);

    await s.answer(id, 'support_tried', 'unknown');
    assert.deepEqual(await answers(), { years_using: '2_4', support_tried: 'unknown' });

    await s.answer(id, 'support_tried', 'tried');
    assert.deepEqual(await answers(), { years_using: '2_4', support_tried: 'tried' }, 'they are not brought back');
    assert.equal((await s.answer(id, 'support_rating', 3)).status, 200);

    // the database agrees with the API
    const rows = s.db.prepare('SELECT question_id FROM answers WHERE submission_id = ? ORDER BY question_id').all(id);
    assert.deepEqual(rows.map((r) => r.question_id), ['support_rating', 'support_tried', 'years_using']);
  } finally {
    await s.stop();
  }
});

test('the reason for thinking about leaving is only asked of people who said Jā', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    const answers = async () => (await s.call('GET', `/api/submissions/${id}`)).json.answers;
    assert.equal((await s.answer(id, 'leaving_reason', 'Lēns')).status, 400, 'hidden before the answer');
    await s.answer(id, 'considered_leaving', 'no');
    assert.equal((await s.answer(id, 'leaving_reason', 'Lēns')).status, 400);
    await s.answer(id, 'considered_leaving', 'yes');
    assert.equal((await s.answer(id, 'leaving_reason', 'Lēns')).status, 200);
    assert.equal((await s.answer(id, 'leaving_reason', 'x'.repeat(1001))).status, 400);
    assert.deepEqual(await answers(), { considered_leaving: 'yes', leaving_reason: 'Lēns' });
    await s.answer(id, 'considered_leaving', 'no');
    assert.deepEqual(await answers(), { considered_leaving: 'no' }, 'the reason goes when the answer changes to Nē');
  } finally {
    await s.stop();
  }
});

test('the support rating becomes required only when it is shown; the comments never are', async () => {
  const s = await startServer();
  try {
    // somebody who did not contact support finishes without any support follow-up
    const knew = await submitAll(s, { support_tried: 'knew' });
    assert.deepEqual(
      Object.keys((await s.call('GET', `/api/submissions/${knew}`)).json.answers).filter((k) => k.startsWith('support_')),
      ['support_tried'],
    );

    // somebody who did contact support has to rate it
    const id = await s.newSubmission();
    for (const [qid, value] of Object.entries(validAnswers({ support_tried: 'tried' }))) {
      if (qid !== 'support_rating') await s.answer(id, qid, value);
    }
    const res = await s.call('POST', `/api/submissions/${id}/complete`);
    assert.equal(res.status, 422);
    assert.deepEqual(res.json.missing, ['support_rating']);
    await s.answer(id, 'support_rating', 5);
    assert.equal((await s.call('POST', `/api/submissions/${id}/complete`)).status, 200);
  } finally {
    await s.stop();
  }
});

test('a respondent has to answer every required question on their path', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    await s.answer(id, 'years_using', '2_4');
    const res = await s.call('POST', `/api/submissions/${id}/complete`);
    assert.equal(res.status, 422);
    assert.deepEqual(res.json.missing, [
      'age_group', 'gender', 'city', 'email_frequency', 'email_purpose', 'inbox_products', 'news_channel',
      'feedback_channel', 'feedback_ease', 'satisfaction', 'recommend', 'improvements_noticed', 'premium_used', 'support_tried', 'considered_leaving',
    ]);
  } finally {
    await s.stop();
  }
});

test('results count the support rating only among the people who were asked', async () => {
  const s = await startServer();
  try {
    await submitAll(s, { support_tried: 'tried', support_rating: 5, considered_leaving: 'yes', leaving_reason: 'Dārgi' });
    await submitAll(s, { support_tried: 'knew', considered_leaving: 'no' });
    await submitAll(s, { support_tried: 'unknown', considered_leaving: 'no' });
    const results = (await s.call('GET', `/api/results?token=${TOKEN}`)).json;
    const q = (id) => results.questions.find((x) => x.id === id);
    assert.equal(q('support_tried').answered, 3);
    assert.deepEqual(Object.fromEntries(q('support_tried').options.map((o) => [o.value, o.count])), { tried: 1, knew: 1, unknown: 1 });
    assert.equal(q('support_rating').answered, 1);
    assert.equal(q('support_rating').average, 5);
    assert.deepEqual(Object.fromEntries(q('considered_leaving').options.map((o) => [o.value, o.count])), { yes: 1, no: 2 });
    assert.deepEqual(q('leaving_reason').texts, [{ text: 'Dārgi' }]);
    assert.deepEqual(results.totals, { started: 3, completed: 3 });
  } finally {
    await s.stop();
  }
});

test('removed questions are archived: not asked any more, listed in the results only when somebody answered them', async () => {
  const s = await startServer();
  try {
    await submitAll(s);
    const results = (await s.call('GET', `/api/results?token=${TOKEN}`)).json;
    const ids = results.questions.map((q) => q.id);
    const removed = ['one_word', 'not_using_reason', 'news_frequency', 'support_comment', 'region'];
    for (const id of removed) {
      assert.equal(ids.includes(id), false, `${id} has no answers, so it is not listed`);
      assert.equal((await s.answer(await s.newSubmission(), id, 'x')).status, 404, `${id} cannot be answered any more`);
    }
    // ...but the CSV keeps a column for each of them, after the live questions
    const csv = (await s.call('GET', `/api/export.csv?token=${TOKEN}`)).text;
    const header = csv.slice(1).split('\r\n')[0].split(',');
    for (const id of removed) assert.ok(header.includes(id), `${id} column`);

    // answers that no longer exist are refused too
    const id = await s.newSubmission();
    for (const [qid, value] of [['years_using', 'not_using'], ['years_using', 'under_1'], ['years_using', '2'], ['age_group', 'under_18'], ['email_purpose', ['bills']], ['inbox_products', ['dating']], ['inbox_products', ['xtv']], ['premium_used', 'never_known_old']]) {
      assert.equal((await s.answer(id, qid, value)).status, 400, `${qid}=${JSON.stringify(value)}`);
    }
  } finally {
    await s.stop();
  }
});

test('answers given to the old survey stay visible: removed questions and removed options show up in the results and the CSV', async () => {
  const s = await startServer();
  try {
    // two people who answered the old survey (their answers are written straight into the database, as the old version did)
    const old = (id, completed, answers) => {
      s.db.prepare('INSERT INTO submissions (id, created_at, completed_at) VALUES (?, ?, ?)').run(id, '2026-11-10T10:00:00.000Z', completed ? '2026-11-10T10:05:00.000Z' : null);
      for (const [qid, value] of Object.entries(answers)) {
        s.db.prepare('INSERT INTO answers (submission_id, question_id, value, updated_at) VALUES (?, ?, ?, ?)').run(id, qid, JSON.stringify(value), '2026-11-10T10:01:00.000Z');
      }
    };
    old('00000000-0000-4000-8000-000000000001', true, { age_group: 'under_18', years_using: '2', one_word: 'ātrs', news_frequency: 'monthly', news_channel: ['email'], inbox_products: ['dating', 'mobile_app'] });
    old('00000000-0000-4000-8000-000000000002', true, { age_group: '25_34', years_using: 'not_using', not_using_reason: 'Lietoju citu pastu', one_word: 'ērts' });
    await submitAll(s); // somebody on the current survey

    const results = (await s.call('GET', `/api/results?token=${TOKEN}`)).json;
    const q = (id) => results.questions.find((x) => x.id === id);
    assert.deepEqual(results.totals, { started: 3, completed: 3 });

    // removed questions with answers are listed, flagged, and after all the live questions
    const archivedIds = results.questions.filter((x) => x.archived).map((x) => x.id);
    assert.deepEqual(archivedIds, ['not_using_reason', 'one_word', 'news_frequency']);
    assert.ok(results.questions.findIndex((x) => x.archived) > results.questions.findIndex((x) => x.id === 'anything_else'));
    assert.deepEqual(q('one_word').texts.map((t) => t.text).sort(), ['ātrs', 'ērts']);
    assert.deepEqual(q('not_using_reason').texts, [{ text: 'Lietoju citu pastu' }]);
    assert.equal(q('news_frequency').options.find((o) => o.value === 'monthly').count, 1);
    assert.equal(q('region'), undefined, 'a removed question nobody answered is not listed');
    assert.equal(q('support_comment'), undefined);

    // removed options of live questions are counted and flagged, and only when used
    const years = Object.fromEntries(q('years_using').options.filter((o) => o.count).map((o) => [o.value, { count: o.count, archived: o.archived === true }]));
    assert.deepEqual(years, { '2': { count: 1, archived: true }, not_using: { count: 1, archived: true }, '0_1': { count: 1, archived: false } });
    assert.deepEqual(q('age_group').options.filter((o) => o.archived).map((o) => [o.value, o.count]), [['under_18', 1]]);
    assert.deepEqual(q('inbox_products').options.filter((o) => o.archived).map((o) => [o.value, o.count]), [['dating', 1]], 'unused archived options (pp, xtv) are left out');
    assert.equal(q('inbox_products').options.find((o) => o.value === 'mobile_app').count, 2, 'live options count old and new answers together');

    // the CSV has them too
    const csv = (await s.call('GET', `/api/export.csv?token=${TOKEN}`)).text;
    const lines = csv.slice(1).split('\r\n').filter(Boolean);
    const header = lines[0].split(',');
    const row = lines.find((l) => l.startsWith('00000000-0000-4000-8000-000000000002')).split(',');
    assert.equal(row[header.indexOf('one_word')], 'ērts');
    assert.equal(row[header.indexOf('not_using_reason')], 'Lietoju citu pastu');
    assert.equal(row[header.indexOf('years_using')], 'not_using');

    // and the statistics page gets the whole export, including the old answers and the date the current survey started
    const exported = (await s.call('GET', `/api/export.json?token=${TOKEN}`)).json;
    assert.equal(exported.config.currentSince, config.currentSince);
    assert.equal(exported.config.archived.length, config.archived.length);
    assert.equal(exported.subs.length, 3);
  } finally {
    await s.stop();
  }
});

test('"Cits" in the e-mail purpose question works the same way', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    const answers = async () => (await s.call('GET', `/api/submissions/${id}`)).json.answers;
    await s.answer(id, 'email_purpose', ['work', 'spam']);
    assert.equal((await s.answer(id, 'email_purpose_other', 'Konkursiem')).status, 400, 'hidden until "Cits" is chosen');
    await s.answer(id, 'email_purpose', ['work', 'spam', 'other']);
    assert.equal((await s.answer(id, 'email_purpose_other', '  Konkursiem  ')).status, 200);
    assert.equal((await answers()).email_purpose_other, 'Konkursiem');
    assert.equal((await s.answer(id, 'email_purpose_other', 'x'.repeat(201))).status, 400);
    await s.answer(id, 'email_purpose', ['work']);
    assert.deepEqual(await answers(), { email_purpose: ['work'] }, 'the text goes when "Cits" is unselected');
  } finally {
    await s.stop();
  }
});

test('feedback channels accept several answers, and the write-in text shows up in the results', async () => {
  const s = await startServer();
  try {
    await submitAll(s, { years_using: '2_4', feedback_channel: ['email_survey', 'social'], news_channel: ['other'], news_channel_other: 'Telegram' });
    await submitAll(s, { years_using: '2_4', feedback_channel: ['social'] });
    const results = (await s.call('GET', `/api/results?token=${TOKEN}`)).json;
    const q = (id) => results.questions.find((x) => x.id === id);
    const counts = Object.fromEntries(q('feedback_channel').options.map((o) => [o.value, o.count]));
    assert.deepEqual(counts, { email_survey: 1, support_team: 0, mobile_app_form: 0, social: 2 });
    assert.deepEqual(q('news_channel_other').texts, [{ text: 'Telegram' }]);
  } finally {
    await s.stop();
  }
});

/* ---------- statistics page ---------- */

test('the JSON export for the statistics page needs the admin token and holds every submission', async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call('GET', '/api/export.json')).status, 401);
    assert.equal((await s.call('GET', '/api/export.json?token=wrong')).status, 401);

    const done = await submitAll(s);
    const open = await s.newSubmission();
    await s.answer(open, 'age_group', '25_34');

    const res = await s.call('GET', `/api/export.json?token=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.config.questions.length, config.questions.length);
    assert.deepEqual(res.json.subs.map((x) => x.id), [done, open], 'oldest first');
    assert.ok(res.json.subs[0].completedAt);
    assert.equal(res.json.subs[1].completedAt, null);
    assert.deepEqual(res.json.subs[1].answers, { age_group: '25_34' });
  } finally {
    await s.stop();
  }
});

test('/stats redirects to /stats/ and the statistics page is served', async () => {
  const s = await startServer();
  try {
    const redirect = await fetch(`${s.base}/stats`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/stats/');

    const page = await s.call('GET', '/stats/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.text, /Aptaujas statistika/);
    assert.equal((await s.call('GET', '/stats.js')).status, 200);
    assert.equal((await s.call('GET', '/stats-data.js')).status, 200);
  } finally {
    await s.stop();
  }
});

test('"Kāpēc neizvēlaties Inbox.lv Premium?" is asked only of people who used Premium before or know it and do not use it', async () => {
  const s = await startServer();
  try {
    const id = await s.newSubmission();
    const answers = async () => (await s.call('GET', `/api/submissions/${id}`)).json.answers;

    assert.equal((await s.answer(id, 'premium_reason', 'Dārgi')).status, 400, 'hidden before the answer');
    for (const hidden of ['now', 'unknown']) {
      await s.answer(id, 'premium_used', hidden);
      assert.equal((await s.answer(id, 'premium_reason', 'Dārgi')).status, 400, hidden);
    }
    for (const shown of ['before', 'never_known']) {
      await s.answer(id, 'premium_used', shown);
      assert.equal((await s.answer(id, 'premium_reason', '  Par dārgu, pietiek ar bezmaksas  ')).status, 200, shown);
      assert.deepEqual(await answers(), { premium_used: shown, premium_reason: 'Par dārgu, pietiek ar bezmaksas' });
    }
    assert.equal((await s.answer(id, 'premium_reason', 'x'.repeat(1001))).status, 400);
    assert.equal((await s.answer(id, 'premium_reason', '   ')).status, 200, 'an empty text clears it: the question is optional');
    assert.equal((await answers()).premium_reason, undefined);

    await s.answer(id, 'premium_reason', 'Vēlreiz');
    await s.answer(id, 'premium_used', 'now'); // no longer one of the answers that ask for a reason
    assert.deepEqual(await answers(), { premium_used: 'now' }, 'the reason goes with the answer');
  } finally {
    await s.stop();
  }
});

test('a respondent who used Premium before can finish with or without writing a reason', async () => {
  const s = await startServer();
  try {
    const without = await submitAll(s, { premium_used: 'before' });
    assert.equal((await s.call('GET', `/api/submissions/${without}`)).json.answers.premium_reason, 'Teksts: premium_reason', 'the helper answers every visible question');
    const id = await s.newSubmission();
    for (const [qid, value] of Object.entries(validAnswers({ premium_used: 'never_known' }))) {
      if (qid !== 'premium_reason') await s.answer(id, qid, value);
    }
    assert.equal((await s.call('POST', `/api/submissions/${id}/complete`)).status, 200, 'the reason is optional');
  } finally {
    await s.stop();
  }
});
