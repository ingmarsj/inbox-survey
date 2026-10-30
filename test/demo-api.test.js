import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi } from '../public/demo-api.js';
import { config, validAnswers } from './helpers.js';

/** A minimal localStorage look-alike, shareable between two demo API instances. */
function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
}

const newDemo = (storage = fakeStorage()) => createDemoApi({ loadQuestions: async () => config, storage });

/** Runs a call and returns the error it throws (or null). */
async function failure(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

test('demo API serves the questions without any server', async () => {
  const api = newDemo();
  const res = await api('GET', 'api/questions');
  assert.equal(res.questions.length, config.questions.length);
  assert.equal(res.intro.button, config.intro.button);
});

test('demo API runs a whole survey in the browser', async () => {
  const api = newDemo();
  const { id } = await api('POST', 'api/submissions');
  for (const [qid, value] of Object.entries(validAnswers())) {
    await api('PUT', `api/submissions/${id}/answers/${qid}`, { value });
  }
  await api('POST', `api/submissions/${id}/complete`);

  const sub = await api('GET', `api/submissions/${id}`);
  assert.equal(sub.completed, true);
  assert.deepEqual(sub.answers, validAnswers());
});

test('demo API applies the same validation as the server', async () => {
  const api = newDemo();
  const { id } = await api('POST', 'api/submissions');

  assert.equal((await failure(api('PUT', `api/submissions/${id}/answers/years_using`, { value: 'martian' }))).status, 400);
  assert.equal((await failure(api('PUT', `api/submissions/${id}/answers/nps`, { value: 11 }))).status, 400);
  assert.equal((await failure(api('PUT', `api/submissions/${id}/answers/nope`, { value: 'x' }))).status, 404);
  assert.equal((await failure(api('PUT', `api/submissions/${id}/answers/years_using`, { value: null }))).status, 400);
  assert.deepEqual((await api('GET', `api/submissions/${id}`)).answers, {});
});

test('demo API refuses to complete with required answers missing and then locks the submission', async () => {
  const api = newDemo();
  const { id } = await api('POST', 'api/submissions');
  await api('PUT', `api/submissions/${id}/answers/years_using`, { value: '1' });

  const err = await failure(api('POST', `api/submissions/${id}/complete`));
  assert.equal(err.status, 422);
  const required = config.questions.filter((q) => q.required).map((q) => q.id);
  assert.deepEqual(err.data.missing, required.filter((qid) => qid !== 'years_using'));

  for (const [qid, value] of Object.entries(validAnswers())) await api('PUT', `api/submissions/${id}/answers/${qid}`, { value });
  await api('POST', `api/submissions/${id}/complete`);
  assert.equal((await failure(api('PUT', `api/submissions/${id}/answers/years_using`, { value: '2' }))).status, 409);
});

test('optional answers can be cleared', async () => {
  const api = newDemo();
  const { id } = await api('POST', 'api/submissions');
  await api('PUT', `api/submissions/${id}/answers/pain_point`, { value: 'Slow' });
  await api('PUT', `api/submissions/${id}/answers/pain_point`, { value: '   ' });
  assert.equal((await api('GET', `api/submissions/${id}`)).answers.pain_point, undefined);
});

test('progress survives a page reload (same storage) but not a different browser (new storage)', async () => {
  const storage = fakeStorage();
  const first = newDemo(storage);
  const { id } = await first('POST', 'api/submissions');
  await first('PUT', `api/submissions/${id}/answers/years_using`, { value: '3' });

  const afterReload = newDemo(storage);
  assert.deepEqual((await afterReload('GET', `api/submissions/${id}`)).answers, { years_using: '3' });

  const otherBrowser = newDemo(fakeStorage());
  assert.equal((await failure(otherBrowser('GET', `api/submissions/${id}`))).status, 404);
});

test('unknown routes and submissions are 404, and a leading slash is tolerated', async () => {
  const api = newDemo();
  assert.equal((await failure(api('GET', 'api/unknown'))).status, 404);
  assert.equal((await failure(api('GET', 'api/submissions/missing'))).status, 404);
  assert.ok((await api('GET', '/api/questions')).questions.length > 0);
});

test('demo API works without usable localStorage (falls back to memory)', async () => {
  const api = createDemoApi({ loadQuestions: async () => config });
  const { id } = await api('POST', 'api/submissions');
  await api('PUT', `api/submissions/${id}/answers/years_using`, { value: '4' });
  assert.equal((await api('GET', `api/submissions/${id}`)).answers.years_using, '4');
});
