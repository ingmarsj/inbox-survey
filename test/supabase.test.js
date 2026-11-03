import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { validateAnswer } from '../questions.js';
import { aggregateSubmissions } from '../public/aggregate.js';
import { currentSeedSql, SEED_FILE } from '../scripts/build-supabase-sql.mjs';
import { config, validAnswers } from './helpers.js';

// These tests run the real SQL from supabase/schema.sql in an in-process Postgres (PGlite),
// so the functions that will run on Supabase are exercised without a network or an account.

const SCHEMA = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const TOKEN = 'a-long-random-test-secret';

let db;

before(async () => {
  db = new PGlite();
  // Supabase has these roles already.
  await db.exec('create role anon nologin; create role authenticated nologin;');
  await db.exec(SCHEMA);
  await db.exec(currentSeedSql());
  await db.query(
    "insert into public.survey_meta (key, value) values ('admin_token_sha256', encode(sha256(convert_to($1, 'UTF8')), 'hex'))",
    [TOKEN],
  );
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('truncate public.survey_answers, public.survey_submissions cascade');
});

/** undefined -> SQL NULL, anything else -> a JSON value (so null becomes JSON null). */
const json = (value) => (value === undefined ? null : JSON.stringify(value));

async function rpc(fn, ...args) {
  const params = args.map((_, i) => `$${i + 1}`).join(', ');
  const result = await db.query(`select public.${fn}(${params}) as result`, args);
  return result.rows[0].result;
}

const create = () => rpc('survey_create_submission');
const save = (id, question, value) => rpc('survey_save_answer', id, question, json(value));
const get = (id) => rpc('survey_get_submission', id);
const complete = (id) => rpc('survey_complete', id);
const answersOf = async (id) => (await get(id)).answers;

/** Fills a whole submission and completes it. */
async function submitAll(overrides = {}) {
  const id = await create();
  for (const [qid, value] of Object.entries(validAnswers(overrides))) await save(id, qid, value);
  assert.deepEqual(await complete(id), { ok: true });
  return id;
}

const byId = (id) => config.questions.find((q) => q.id === id);

/* ---------- the SQL must judge answers exactly like public/validate.js ---------- */

function vectorsFor(q) {
  const common = [undefined, null, 7, true, {}, [], 'x', ''];
  switch (q.type) {
    case 'single':
      return [...common, ...q.options.map((o) => o.value), 'martian', ['x'], q.options[0].value + ' '];
    case 'multi': {
      const [a, b] = q.options.map((o) => o.value);
      return [...common, [a], [a, a], [a, b], q.options.map((o) => o.value), ['martian'], [a, 1], [null]];
    }
    case 'scale':
      return [...common, q.min, q.max, q.min - 1, q.max + 1, 2.5, '3', 0];
    default: {
      const max = q.maxLength ?? 1000;
      return [...common, 'abc', '  abc  ', '   ', '\t\n', 'x'.repeat(max), 'x'.repeat(max + 1), '😀'.repeat(max), '😀'.repeat(max + 1), 42];
    }
  }
}

test('SQL validation agrees with the JavaScript validation for every question and many values', async () => {
  const [multi] = config.questions.filter((q) => q.type === 'multi');
  const questions = [...config.questions, { ...multi, id: 'limited', maxSelect: 1 }];
  let compared = 0;
  for (const q of questions) {
    const vectors = q.id === 'limited' ? [[multi.options[0].value, multi.options[1].value], [multi.options[0].value]] : vectorsFor(q);
    for (const value of vectors) {
      const expected = validateAnswer(q, value);
      const actual = await rpc('_survey_validate', JSON.stringify(q), json(value));
      const label = `${q.id} <- ${JSON.stringify(value)?.slice(0, 40)}`;
      assert.equal(actual.ok, expected.ok, label);
      if (expected.ok) assert.deepEqual(actual.value, expected.value, label);
      else assert.equal(actual.error, expected.error, label);
      compared += 1;
    }
  }
  assert.ok(compared > 150, `compared ${compared} cases`);
});

test('SQL visibility rules agree with the JavaScript ones', async () => {
  const { isQuestionVisible } = await import('../questions.js');
  for (const years of [undefined, 'not_using', 'under_1', '3']) {
    const answers = years === undefined ? {} : { years_using: years };
    for (const q of config.questions) {
      const actual = await rpc('_survey_visible', JSON.stringify(q), JSON.stringify(answers));
      assert.equal(actual, isQuestionVisible(q, answers), `${q.id} with ${years}`);
    }
  }
});

/* ---------- the respondent journey ---------- */

test('config is served from the database', async () => {
  const served = await rpc('survey_get_config');
  assert.deepEqual(served, JSON.parse(JSON.stringify(config)));
});

test('a respondent can go through the whole survey', async () => {
  const id = await submitAll();
  const sub = await get(id);
  assert.equal(sub.completed, true);
  assert.deepEqual(sub.answers, validAnswers());
  assert.equal((await db.query('select count(*)::int as n from public.survey_answers where submission_id = $1', [id])).rows[0].n, Object.keys(validAnswers()).length);
});

test('progress is saved as the respondent goes, so reloading resumes', async () => {
  const id = await create();
  await save(id, 'years_using', '2');
  await save(id, 'recommend', 4);
  assert.deepEqual(await get(id), { id, completed: false, answers: { years_using: '2', recommend: 4 } });
});

test('changing an answer overwrites it; optional text can be cleared, required answers cannot', async () => {
  const id = await create();
  await save(id, 'years_using', '1');
  await save(id, 'years_using', '2');
  assert.equal((await db.query('select count(*)::int as n from public.survey_answers where submission_id = $1', [id])).rows[0].n, 1);
  assert.equal((await answersOf(id)).years_using, '2');

  await save(id, 'pain_point', 'Slow');
  await save(id, 'pain_point', '   ');
  assert.equal((await answersOf(id)).pain_point, undefined);

  await assert.rejects(save(id, 'years_using', null), /survey_invalid: This question is required/);
  assert.equal((await answersOf(id)).years_using, '2');
});

test('invalid answers are rejected and nothing is stored', async () => {
  const id = await create();
  const cases = [
    ['years_using', 'martian'],
    ['years_using', 7],
    ['news_channel', 'email'],
    ['news_channel', ['email', 'nope']],
    ['recommend', 6],
    ['recommend', '4'],
    ['feedback_ease', 3],
    ['age_group', 'ancient'],
    ['one_word', 'x'.repeat(41)],
    ['pain_point', { a: 1 }],
  ];
  for (const [qid, value] of cases) {
    await assert.rejects(save(id, qid, value), /survey_invalid/, `${qid}=${JSON.stringify(value)}`);
  }
  assert.deepEqual(await answersOf(id), {});
});

test('unknown submissions and questions are refused', async () => {
  const id = await create();
  const unknown = '00000000-0000-4000-8000-000000000000';
  await assert.rejects(save(unknown, 'years_using', '1'), /survey_not_found/);
  await assert.rejects(get(unknown), /survey_not_found/);
  await assert.rejects(complete(unknown), /survey_not_found/);
  await assert.rejects(save(id, 'no_such_question', 'x'), /survey_question_not_found/);
});

test('completing needs every required question; then the submission is locked', async () => {
  const id = await create();
  await save(id, 'years_using', '4');
  const required = config.questions.filter((q) => q.required).map((q) => q.id);
  assert.deepEqual(await complete(id), { ok: false, missing: required.filter((qid) => qid !== 'years_using') });

  for (const [qid, value] of Object.entries(validAnswers())) await save(id, qid, value);
  assert.deepEqual(await complete(id), { ok: true });
  assert.deepEqual(await complete(id), { ok: true }, 'completing twice is harmless');
  await assert.rejects(save(id, 'years_using', '2'), /survey_already_submitted/);
});

test('optional questions may stay empty and the survey still completes', async () => {
  const id = await create();
  for (const q of config.questions.filter((x) => x.required)) await save(id, q.id, validAnswers()[q.id]);
  assert.deepEqual(await complete(id), { ok: true });
});

/* ---------- the short path for people who do not use Inbox.lv ---------- */

test('non-users have a short path: demographics, first answer, then reason and free text', async () => {
  const id = await create();
  await save(id, 'age_group', '25_34');
  await save(id, 'gender', 'no_answer');
  await save(id, 'years_using', 'not_using');
  assert.deepEqual(await complete(id), { ok: true });

  const full = await submitAll({ years_using: 'not_using' });
  assert.deepEqual(Object.keys(await answersOf(full)).sort(), ['age_group', 'anything_else', 'gender', 'not_using_reason', 'one_word', 'years_using']);
});

test('answers for questions off the respondent path are rejected', async () => {
  const nonUser = await create();
  await save(nonUser, 'years_using', 'not_using');
  for (const [qid, value] of [['news_channel', ['email']], ['recommend', 4], ['pain_point', 'Slow']]) {
    await assert.rejects(save(nonUser, qid, value), /survey_not_on_path/, qid);
  }
  const user = await create();
  await save(user, 'years_using', '2');
  await assert.rejects(save(user, 'not_using_reason', 'Because'), /survey_not_on_path/);
  await assert.rejects(save(await create(), 'not_using_reason', 'Because'), /survey_not_on_path/, 'hidden until the first answer says so');
});

test('changing the first answer drops the answers that no longer belong to the new path', async () => {
  const id = await create();
  await save(id, 'years_using', '2');
  await save(id, 'news_channel', ['email']);
  await save(id, 'recommend', 4);
  await save(id, 'one_word', 'ātrs');

  await save(id, 'years_using', 'not_using');
  assert.deepEqual(await answersOf(id), { years_using: 'not_using', one_word: 'ātrs' });

  await save(id, 'not_using_reason', 'Use another mailbox');
  await save(id, 'years_using', '3');
  assert.deepEqual(await answersOf(id), { years_using: '3', one_word: 'ātrs' });
});

/* ---------- results ---------- */

test('the results export needs the secret token', async () => {
  await assert.rejects(rpc('survey_export', 'wrong'), /survey_unauthorized/);
  await assert.rejects(rpc('survey_export', null), /survey_unauthorized/);
  await assert.rejects(rpc('survey_export', ''), /survey_unauthorized/);
  const ok = await rpc('survey_export', TOKEN);
  assert.deepEqual(ok.submissions, []);
  assert.equal(ok.config.questions.length, config.questions.length);
});

test('the export feeds the same aggregation as the Node server', async () => {
  await submitAll({ years_using: '1', recommend: 5, feedback_channel: 'in_app_survey', news_channel: ['email'], satisfaction: 5, one_word: 'ātrs' });
  await submitAll({ years_using: '2', recommend: 4, feedback_channel: 'email_reply', news_channel: ['email', 'website'], satisfaction: 4, one_word: 'ērts' });
  await submitAll({ years_using: 'not_using', not_using_reason: 'No need' });
  const partial = await create();
  await save(partial, 'years_using', '2');
  await save(partial, 'recommend', 3);

  const exported = await rpc('survey_export', TOKEN);
  assert.equal(exported.submissions.length, 4);
  const subs = exported.submissions.map((s) => ({ id: s.id, createdAt: s.created_at, completedAt: s.completed_at, answers: s.answers }));
  const results = aggregateSubmissions(exported.config, subs);
  const q = (id) => results.questions.find((x) => x.id === id);

  assert.deepEqual(results.totals, { started: 4, completed: 3 });
  assert.equal(q('recommend').answered, 3);
  assert.equal(q('recommend').average, (5 + 4 + 3) / 3);
  assert.equal(q('news_channel').options.find((o) => o.value === 'email').count, 2);
  assert.deepEqual(q('not_using_reason').texts, [{ text: 'No need' }]);
  assert.equal(q('years_using').options.find((o) => o.value === 'not_using').count, 1);
  // the non-user also gave the default free-text answer
  assert.deepEqual(q('one_word').texts.map((t) => t.text).sort(), ['Teksts: one_word', 'ātrs', 'ērts']);
});

/* ---------- access control ---------- */

test('the public API key cannot read or write the tables, only call the survey functions', async () => {
  await db.exec('set role anon');
  try {
    for (const table of ['survey_answers', 'survey_submissions', 'survey_config', 'survey_meta']) {
      await assert.rejects(db.query(`select * from public.${table}`), /permission denied/, table);
      await assert.rejects(db.query(`delete from public.${table}`), /permission denied/, table);
    }
    await assert.rejects(db.query("insert into public.survey_submissions (id) values (gen_random_uuid())"), /permission denied/);
    await assert.rejects(db.query("select public._survey_validate('{}'::jsonb, 'null'::jsonb)"), /permission denied/, 'helpers are private');

    // ...but the respondent flow works for anon
    const id = await create();
    await save(id, 'years_using', '2');
    assert.equal((await answersOf(id)).years_using, '2');
    assert.equal((await rpc('survey_get_config')).questions.length, config.questions.length);
    await assert.rejects(rpc('survey_export', 'wrong'), /survey_unauthorized/);
  } finally {
    await db.exec('reset role');
  }
});

test('the token is stored only as a hash', async () => {
  const { rows } = await db.query("select value from public.survey_meta where key = 'admin_token_sha256'");
  assert.match(rows[0].value, /^[0-9a-f]{64}$/);
  assert.ok(!rows[0].value.includes(TOKEN));
});

/* ---------- installing and updating ---------- */

test('schema.sql and the seed can be run again without errors or duplicates', async () => {
  const id = await submitAll();
  await db.exec(SCHEMA);
  await db.exec(currentSeedSql());
  assert.equal((await db.query('select count(*)::int as n from public.survey_config')).rows[0].n, 1);
  assert.equal((await get(id)).completed, true, 'existing answers survive a re-run');
});

test('the checked-in seed file is up to date with questions.json', () => {
  assert.equal(readFileSync(SEED_FILE, 'utf8'), currentSeedSql(), 'run: node scripts/build-supabase-sql.mjs');
});

test('the SQL only creates survey_ objects and never drops anything', () => {
  assert.doesNotMatch(SCHEMA, /\bdrop\s+(table|function|schema|policy)\b/i);
  assert.doesNotMatch(SCHEMA, /\balter\s+table\s+(?!public\.survey_)/i);
  const created = [...SCHEMA.matchAll(/create\s+(?:or\s+replace\s+)?(?:table|function)\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi)].map((m) => m[1]);
  assert.ok(created.length >= 12);
  for (const name of created) assert.match(name, /^_?survey_/, name);
});
