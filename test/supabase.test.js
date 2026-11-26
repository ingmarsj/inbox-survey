import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { validateAnswer, isQuestionVisible } from '../questions.js';
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
  const situations = [
    {},
    { years_using: '0_1' },
    { years_using: '2_4' },
    { years_using: '2_4', news_channel: ['other'] },
    { years_using: '2_4', news_channel: ['email', 'other'] },
    { years_using: '2_4', news_channel: ['email'] },
    { years_using: '2_4', news_channel: [] },
    { years_using: '2_4', news_channel: 'other' }, // a stale single value from an older version of the question
    { email_purpose: ['work', 'other'] },
    { email_purpose: ['work'] },
    { support_tried: 'tried' },
    { support_tried: 'knew' },
    { support_tried: 'unknown' },
    { support_tried: 'martian' },
    { considered_leaving: 'yes' },
    { considered_leaving: 'no' },
    { years_using: 'not_using' }, // an option that no longer exists: nothing special happens
    { support_tried: 'tried', considered_leaving: 'yes', email_purpose: ['other'], news_channel: ['other'] },
    { premium_used: 'now' },
    { premium_used: 'before' },
    { premium_used: 'never_known' },
    { premium_used: 'unknown' },
    { premium_used: 'martian' },
    { premium_used: ['before'] }, // a stale multiple-choice value does not match an "in" rule
    { premium_used: null },
  ];
  for (const answers of situations) {
    for (const q of config.questions) {
      const actual = await rpc('_survey_visible', JSON.stringify(q), JSON.stringify(answers));
      assert.equal(actual, isQuestionVisible(q, answers), `${q.id} with ${JSON.stringify(answers)}`);
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
  await save(id, 'years_using', '2_4');
  await save(id, 'recommend', 4);
  assert.deepEqual(await get(id), { id, completed: false, answers: { years_using: '2_4', recommend: 4 } });
});

test('changing an answer overwrites it; optional text can be cleared, required answers cannot', async () => {
  const id = await create();
  await save(id, 'years_using', '0_1');
  await save(id, 'years_using', '2_4');
  assert.equal((await db.query('select count(*)::int as n from public.survey_answers where submission_id = $1', [id])).rows[0].n, 1);
  assert.equal((await answersOf(id)).years_using, '2_4');

  await save(id, 'pain_point', 'Slow');
  await save(id, 'pain_point', '   ');
  assert.equal((await answersOf(id)).pain_point, undefined);

  await assert.rejects(save(id, 'years_using', null), /survey_invalid: This question is required/);
  assert.equal((await answersOf(id)).years_using, '2_4');
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
    ['city', 'mars'],
    ['email_frequency', 'hourly'],
    ['inbox_products', 'mobile_app'],
    ['inbox_products', ['mobile_app', 'nope']],
    ['premium_used', 'maybe'],
    ['considered_leaving', 'maybe'],
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
  await assert.rejects(save(unknown, 'years_using', '0_1'), /survey_not_found/);
  await assert.rejects(get(unknown), /survey_not_found/);
  await assert.rejects(complete(unknown), /survey_not_found/);
  await assert.rejects(save(id, 'no_such_question', 'x'), /survey_question_not_found/);
});

test('completing needs every required question; then the submission is locked', async () => {
  const id = await create();
  await save(id, 'years_using', '2_4');
  // only the required questions that are on this respondent's path (the support rating needs "Jā, vērsos atbalstā")
  const required = config.questions.filter((q) => q.required && isQuestionVisible(q, { years_using: '2_4' })).map((q) => q.id);
  assert.deepEqual(await complete(id), { ok: false, missing: required.filter((qid) => qid !== 'years_using') });

  for (const [qid, value] of Object.entries(validAnswers())) await save(id, qid, value);
  assert.deepEqual(await complete(id), { ok: true });
  assert.deepEqual(await complete(id), { ok: true }, 'completing twice is harmless');
  await assert.rejects(save(id, 'years_using', '2_4'), /survey_already_submitted/);
});

test('optional questions may stay empty and the survey still completes', async () => {
  const id = await create();
  for (const q of config.questions.filter((x) => x.required)) await save(id, q.id, validAnswers()[q.id]);
  assert.deepEqual(await complete(id), { ok: true });
});

/* ---------- follow-up questions ---------- */

test('"Cits": the write-in text only exists while "Cits" is selected, and goes with its question', async () => {
  const id = await create();
  await save(id, 'years_using', '2_4');
  await assert.rejects(save(id, 'news_channel_other', 'My blog'), /survey_not_on_path/);

  await save(id, 'news_channel', ['email', 'other']);
  await save(id, 'news_channel_other', '  My blog  ');
  assert.equal((await answersOf(id)).news_channel_other, 'My blog');
  await assert.rejects(save(id, 'news_channel_other', 'x'.repeat(201)), /survey_invalid: Text is too long/);

  await save(id, 'news_channel', ['email']);
  assert.equal((await answersOf(id)).news_channel_other, undefined, 'unselecting "Cits" removes the text');

  // the same for the e-mail purpose question
  await assert.rejects(save(id, 'email_purpose_other', 'Konkursiem'), /survey_not_on_path/);
  await save(id, 'email_purpose', ['work', 'other']);
  await save(id, 'email_purpose_other', 'Konkursiem');
  assert.equal((await answersOf(id)).email_purpose_other, 'Konkursiem');
  await save(id, 'email_purpose', ['work']);
  assert.equal((await answersOf(id)).email_purpose_other, undefined);
});

test('feedback channels take several answers', async () => {
  const id = await create();
  await save(id, 'years_using', '2_4');
  await save(id, 'feedback_channel', ['email_survey', 'social', 'email_survey']);
  assert.deepEqual((await answersOf(id)).feedback_channel, ['email_survey', 'social'], 'duplicates are dropped');
  await assert.rejects(save(id, 'feedback_channel', 'social'), /survey_invalid: Invalid answer/);
  await assert.rejects(save(id, 'feedback_channel', ['email_reply']), /survey_invalid: Invalid answer/, 'an option that was removed');
});

test('the support rating is on the path only after "Jā, esmu vērsies"', async () => {
  const id = await create();
  await assert.rejects(save(id, 'support_rating', 4), /survey_not_on_path/, 'hidden until the first answer says so');
  await save(id, 'support_tried', 'knew');
  await assert.rejects(save(id, 'support_rating', 4), /survey_not_on_path/);

  await save(id, 'support_tried', 'tried');
  await save(id, 'support_rating', 4);
  await assert.rejects(save(id, 'support_rating', 6), /survey_invalid/);
  assert.deepEqual(await answersOf(id), { support_tried: 'tried', support_rating: 4 });
});

test('changing the answer they depend on drops the follow-up answers', async () => {
  const id = await create();
  await save(id, 'years_using', '2_4');
  await save(id, 'support_tried', 'tried');
  await save(id, 'support_rating', 5);
  await save(id, 'considered_leaving', 'yes');
  await save(id, 'leaving_reason', 'Dārgi');

  await save(id, 'support_tried', 'unknown');
  assert.deepEqual(await answersOf(id), { years_using: '2_4', support_tried: 'unknown', considered_leaving: 'yes', leaving_reason: 'Dārgi' });
  await save(id, 'considered_leaving', 'no');
  assert.deepEqual(await answersOf(id), { years_using: '2_4', support_tried: 'unknown', considered_leaving: 'no' });

  await save(id, 'support_tried', 'tried');
  assert.deepEqual(await answersOf(id), { years_using: '2_4', support_tried: 'tried', considered_leaving: 'no' }, 'dropped answers do not come back');

  // the database agrees with the API
  const rows = await db.query('select question_id from public.survey_answers where submission_id = $1 order by question_id', [id]);
  assert.deepEqual(rows.rows.map((r) => r.question_id), ['considered_leaving', 'support_tried', 'years_using']);
});

test('somebody who did not contact support finishes without any support follow-up; one who did must rate it', async () => {
  const knew = await submitAll({ support_tried: 'knew' });
  assert.deepEqual(Object.keys(await answersOf(knew)).filter((k) => k.startsWith('support_')), ['support_tried']);

  const id = await create();
  for (const [qid, value] of Object.entries(validAnswers({ support_tried: 'tried' }))) if (qid !== 'support_rating') await save(id, qid, value);
  assert.deepEqual(await complete(id), { ok: false, missing: ['support_rating'] });
  await save(id, 'support_rating', 5);
  assert.deepEqual(await complete(id), { ok: true });
});

test('the removed questions are refused', async () => {
  const id = await create();
  for (const removed of ['one_word', 'not_using_reason', 'news_frequency', 'support_comment', 'region']) {
    await assert.rejects(save(id, removed, 'x'), /survey_question_not_found/, removed);
  }
  for (const [qid, value] of [['years_using', 'not_using'], ['years_using', 'under_1'], ['email_purpose', ['bills']], ['inbox_products', ['dating']], ['inbox_products', ['xtv']]]) {
    await assert.rejects(save(id, qid, value), /survey_invalid/, `${qid}=${JSON.stringify(value)}`);
  }
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
  await submitAll({ years_using: '0_1', recommend: 5, feedback_channel: ['email_survey'], news_channel: ['email'], satisfaction: 5, pain_point: 'ātrs', support_tried: 'tried', support_rating: 5, considered_leaving: 'no' });
  await submitAll({ years_using: '2_4', recommend: 4, feedback_channel: ['support_team'], news_channel: ['email', 'in_app'], satisfaction: 4, pain_point: 'ērts', support_tried: 'knew', considered_leaving: 'yes', leaving_reason: 'Dārgi' });
  const partial = await create();
  await save(partial, 'years_using', '2_4');
  await save(partial, 'recommend', 3);

  const exported = await rpc('survey_export', TOKEN);
  assert.equal(exported.submissions.length, 3);
  const subs = exported.submissions.map((s) => ({ id: s.id, createdAt: s.created_at, completedAt: s.completed_at, answers: s.answers }));
  const results = aggregateSubmissions(exported.config, subs);
  const q = (id) => results.questions.find((x) => x.id === id);

  assert.deepEqual(results.totals, { started: 3, completed: 2 });
  assert.equal(q('recommend').answered, 3);
  assert.equal(q('recommend').average, (5 + 4 + 3) / 3);
  assert.equal(q('news_channel').options.find((o) => o.value === 'email').count, 2);
  assert.equal(q('support_rating').answered, 1, 'only the person who contacted support was asked');
  assert.equal(q('support_rating').average, 5);
  assert.deepEqual(q('leaving_reason').texts, [{ text: 'Dārgi' }]);
  assert.deepEqual(q('pain_point').texts.map((t) => t.text).sort(), ['ātrs', 'ērts']);
  assert.equal(q('one_word'), undefined);
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
    await save(id, 'years_using', '2_4');
    assert.equal((await answersOf(id)).years_using, '2_4');
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

test('the Premium reason is on the path only for "agrāk lietoju" and "zinu, bet nelietoju"; the SQL "in" rule matches the JavaScript one', async () => {
  const id = await create();
  await assert.rejects(save(id, 'premium_reason', 'Dārgi'), /survey_not_on_path/, 'hidden until the first answer says so');
  for (const hidden of ['now', 'unknown']) {
    await save(id, 'premium_used', hidden);
    await assert.rejects(save(id, 'premium_reason', 'Dārgi'), /survey_not_on_path/, hidden);
  }
  for (const shown of ['before', 'never_known']) {
    await save(id, 'premium_used', shown);
    await save(id, 'premium_reason', '  Par dārgu  ');
    assert.deepEqual(await answersOf(id), { premium_used: shown, premium_reason: 'Par dārgu' });
  }
  await assert.rejects(save(id, 'premium_reason', 'x'.repeat(1001)), /survey_invalid/);
  await save(id, 'premium_reason', '   ');
  assert.equal((await answersOf(id)).premium_reason, undefined, 'optional: an empty text clears it');

  await save(id, 'premium_reason', 'Vēlreiz');
  await save(id, 'premium_used', 'unknown');
  assert.deepEqual(await answersOf(id), { premium_used: 'unknown' }, 'the reason is dropped with the answer it depended on');

  // nobody under 18, and the new "Tikai e-pastu" answer is accepted
  await assert.rejects(save(id, 'age_group', 'under_18'), /survey_invalid/);
  await save(id, 'age_group', '18_24');
  await save(id, 'inbox_products', ['email_only']);
  assert.deepEqual((await answersOf(id)).inbox_products, ['email_only']);
});

test('the SQL visibility function understands the "in" rule even for odd rules', async () => {
  const rule = (inValue) => JSON.stringify({ id: 'b', visibleIf: { question: 'a', in: inValue } });
  const visible = async (q, answers) => rpc('_survey_visible', q, JSON.stringify(answers));
  assert.equal(await visible(rule(['x', 'y']), { a: 'x' }), true);
  assert.equal(await visible(rule(['x', 'y']), { a: 'y' }), true);
  assert.equal(await visible(rule(['x', 'y']), { a: 'z' }), false);
  assert.equal(await visible(rule(['x', 'y']), {}), false);
  assert.equal(await visible(rule([]), { a: 'x' }), false);
  assert.equal(await visible(rule('x'), { a: 'x' }), false, 'a rule that is not a list never matches');
});

test('answers given to the old survey stay visible through the Supabase export too', async () => {
  // old answers written straight into the tables, as the old version of the survey did
  const old = async (completed, answers) => {
    const id = await create();
    for (const [qid, value] of Object.entries(answers)) {
      await db.query('insert into public.survey_answers (submission_id, question_id, value) values ($1, $2, $3::jsonb)', [id, qid, JSON.stringify(value)]);
    }
    if (completed) await db.query('update public.survey_submissions set completed_at = now() where id = $1', [id]);
    return id;
  };
  await old(true, { age_group: 'under_18', years_using: '2', one_word: 'ātrs', news_frequency: 'monthly', inbox_products: ['dating', 'mobile_app'] });
  await old(true, { age_group: '25_34', years_using: 'not_using', not_using_reason: 'Lietoju citu pastu', one_word: 'ērts' });
  await submitAll();

  const exported = await rpc('survey_export', TOKEN);
  assert.equal(exported.config.archived.length, config.archived.length, 'the export carries the archive');
  assert.equal(exported.config.currentSince, config.currentSince);
  const subs = exported.submissions.map((s) => ({ id: s.id, createdAt: s.created_at, completedAt: s.completed_at, answers: s.answers }));
  const results = aggregateSubmissions(exported.config, subs);
  const q = (id) => results.questions.find((x) => x.id === id);

  assert.deepEqual(results.questions.filter((x) => x.archived).map((x) => x.id), ['not_using_reason', 'one_word', 'news_frequency']);
  assert.deepEqual(q('one_word').texts.map((t) => t.text).sort(), ['ātrs', 'ērts']);
  assert.equal(q('years_using').options.find((o) => o.value === 'not_using').count, 1);
  assert.equal(q('age_group').options.find((o) => o.value === 'under_18').count, 1);
  assert.equal(q('inbox_products').options.find((o) => o.value === 'dating').archived, true);
  assert.equal(q('inbox_products').options.find((o) => o.value === 'mobile_app').count, 2);

  // the old answers cannot be (re)written through the public functions
  const id = await create();
  await assert.rejects(save(id, 'one_word', 'jauns'), /survey_question_not_found/);
  await assert.rejects(save(id, 'years_using', 'not_using'), /survey_invalid/);
});
