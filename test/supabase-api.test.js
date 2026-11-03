import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createSupabaseApi } from '../public/supabase-api.js';
import { currentSeedSql } from '../scripts/build-supabase-sql.mjs';
import { config, validAnswers } from './helpers.js';

// The browser client talks to the real SQL functions: a tiny stand-in for Supabase's REST layer
// (PostgREST) turns POST /rest/v1/rpc/<name> into a call on an in-process Postgres (PGlite).
// Nothing here needs a network or a Supabase account.

const SCHEMA = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const URL_BASE = 'https://testproject.supabase.co';
const KEY = 'sb_publishable_test_key';
const TOKEN = 'a-long-random-test-secret';

let db;
let calls;

before(async () => {
  db = new PGlite();
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
  calls = [];
});

/** Behaves like Supabase's REST API for RPC calls, and runs them with the anon role. */
async function fakeSupabase(url, init) {
  calls.push({ url, init });
  const match = new URL(url).pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
  if (new URL(url).origin !== URL_BASE || !match) return new Response('{"message":"not found"}', { status: 404 });
  if (init.headers.apikey !== KEY) return new Response('{"message":"Invalid API key"}', { status: 401 });

  const args = JSON.parse(init.body);
  const keys = Object.keys(args);
  const placeholders = keys.map((k, i) => `${k} => $${i + 1}${k === 'p_value' ? '::jsonb' : ''}`).join(', ');
  const values = keys.map((k) => (k === 'p_value' ? JSON.stringify(args[k]) : args[k]));
  await db.exec('set role anon');
  try {
    const { rows } = await db.query(`select public.${match[1]}(${placeholders}) as result`, values);
    // functions that return void answer 204 with no body, like PostgREST does
    if (match[1] === 'survey_save_answer') return new Response(null, { status: 204 });
    return new Response(JSON.stringify(rows[0].result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ code: 'P0001', message: err.message, details: null, hint: null }), { status: 400 });
  } finally {
    await db.exec('reset role');
  }
}

const newApi = (fetchImpl = fakeSupabase) => createSupabaseApi({ url: URL_BASE, key: KEY, fetchImpl });

async function failure(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

test('a whole survey through the Supabase client, end to end', async () => {
  const api = newApi();
  const served = await api('GET', 'api/questions');
  assert.equal(served.questions.length, config.questions.length);

  const { id } = await api('POST', 'api/submissions');
  assert.match(id, /^[0-9a-f-]{36}$/);
  for (const [qid, value] of Object.entries(validAnswers())) {
    assert.deepEqual(await api('PUT', `api/submissions/${id}/answers/${qid}`, { value }), { ok: true });
  }
  assert.deepEqual(await api('POST', `api/submissions/${id}/complete`), { ok: true });

  const sub = await api('GET', `api/submissions/${id}`);
  assert.equal(sub.completed, true);
  assert.deepEqual(sub.answers, validAnswers());
});

test('only the publishable key is sent, to the RPC endpoints of the project', async () => {
  const api = newApi();
  const { id } = await api('POST', 'api/submissions');
  await api('PUT', `api/submissions/${id}/answers/years_using`, { value: '2' });
  await api('GET', `api/submissions/${id}`);

  assert.equal(calls.length, 3);
  for (const { url, init } of calls) {
    assert.match(url, /^https:\/\/testproject\.supabase\.co\/rest\/v1\/rpc\/survey_\w+$/);
    assert.equal(init.method, 'POST');
    assert.deepEqual(Object.keys(init.headers).sort(), ['Content-Type', 'apikey']);
    assert.equal(init.headers.apikey, KEY);
  }
});

test('a leading slash and a trailing slash on the project URL are tolerated', async () => {
  const api = createSupabaseApi({ url: `${URL_BASE}/`, key: KEY, fetchImpl: fakeSupabase });
  assert.equal((await api('GET', '/api/questions')).questions.length, config.questions.length);
});

test('database errors become the same statuses the Node server uses', async () => {
  const api = newApi();
  const { id } = await api('POST', 'api/submissions');
  const put = (qid, value) => api('PUT', `api/submissions/${id}/answers/${qid}`, { value });
  const unknown = '00000000-0000-4000-8000-000000000000';

  assert.equal((await failure(api('GET', `api/submissions/${unknown}`))).status, 404);
  assert.equal((await failure(api('PUT', `api/submissions/${unknown}/answers/years_using`, { value: '1' }))).status, 404);
  assert.equal((await failure(put('no_such_question', 'x'))).status, 404);
  assert.equal((await failure(put('years_using', 'martian'))).status, 400);
  assert.equal((await failure(put('recommend', 9))).status, 400);
  assert.equal((await failure(put('not_using_reason', 'Because'))).status, 400, 'off the path');
  assert.equal((await failure(api('GET', 'api/unknown'))).status, 404);
});

test('completing with required answers missing is a 422 that lists them, and a finished survey is locked (409)', async () => {
  const api = newApi();
  const { id } = await api('POST', 'api/submissions');
  await api('PUT', `api/submissions/${id}/answers/years_using`, { value: '3' });

  const err = await failure(api('POST', `api/submissions/${id}/complete`));
  assert.equal(err.status, 422);
  const required = config.questions.filter((q) => q.required).map((q) => q.id);
  assert.deepEqual(err.data.missing, required.filter((qid) => qid !== 'years_using'));

  for (const [qid, value] of Object.entries(validAnswers())) await api('PUT', `api/submissions/${id}/answers/${qid}`, { value });
  await api('POST', `api/submissions/${id}/complete`);
  assert.equal((await failure(api('PUT', `api/submissions/${id}/answers/years_using`, { value: '1' }))).status, 409);
});

test('an answer can be cleared with null, and a non-user gets the short path', async () => {
  const api = newApi();
  const { id } = await api('POST', 'api/submissions');
  const put = (qid, value) => api('PUT', `api/submissions/${id}/answers/${qid}`, { value });
  await put('pain_point', 'Slow');
  await put('pain_point', null);
  assert.equal((await api('GET', `api/submissions/${id}`)).answers.pain_point, undefined);

  await put('age_group', '25_34');
  await put('gender', 'other');
  await put('years_using', 'not_using');
  assert.deepEqual(await api('POST', `api/submissions/${id}/complete`), { ok: true });
});

test('a network failure is reported as one, so the page keeps retrying', async () => {
  const offline = async () => {
    throw new TypeError('Failed to fetch');
  };
  const err = await failure(newApi(offline)('GET', 'api/questions'));
  assert.equal(err.network, true);
});

test('a server error from Supabase keeps its status (the page retries on 5xx)', async () => {
  const broken = async () => new Response('{"message":"upstream"}', { status: 503 });
  const err = await failure(newApi(broken)('GET', 'api/questions'));
  assert.equal(err.status, 503);
  assert.equal(err.network, undefined);
});

test('the results export works with the token and is refused without it', async () => {
  const api = newApi();
  const { id } = await api('POST', 'api/submissions');
  await api('PUT', `api/submissions/${id}/answers/years_using`, { value: '2' });

  assert.equal((await failure(api.rpc('survey_export', { p_token: 'wrong' }))).status, 401);
  const exported = await api.rpc('survey_export', { p_token: TOKEN });
  assert.equal(exported.submissions.length, 1);
  assert.deepEqual(exported.submissions[0].answers, { years_using: '2' });
});

test('the wrong API key is rejected before anything runs', async () => {
  const api = createSupabaseApi({ url: URL_BASE, key: 'sb_publishable_other', fetchImpl: fakeSupabase });
  assert.equal((await failure(api('GET', 'api/questions'))).status, 401);
});
