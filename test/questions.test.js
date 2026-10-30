import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, validateAnswer } from '../questions.js';
import { config } from './helpers.js';

const byId = (id) => config.questions.find((q) => q.id === id);

test('the shipped questions.json is valid and has the expected shape', () => {
  assert.ok(config.questions.length >= 10);
  assert.ok(config.intro.button);
  const ids = config.questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.equal(ids[0], 'years_using', 'the years dropdown is the first question');
  assert.equal(config.questions.some((q) => q.id.startsWith('direction_')), false, 'no direction questions');
});

test('loadConfig refuses broken configs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const write = (obj) => {
    const file = path.join(dir, 'q.json');
    writeFileSync(file, JSON.stringify(obj));
    return file;
  };
  try {
    const q = { id: 'a', type: 'text', title: 'T' };
    assert.throws(() => loadConfig(write({ questions: [] })), /non-empty/);
    assert.throws(() => loadConfig(write({ questions: [q, q] })), /duplicate id/);
    assert.throws(() => loadConfig(write({ questions: [{ ...q, id: 'Bad Id' }] })), /id must match/);
    assert.throws(() => loadConfig(write({ questions: [{ ...q, type: 'nope' }] })), /unknown type/);
    assert.throws(() => loadConfig(write({ questions: [{ ...q, type: 'single', options: [{ value: 'x', label: 'X' }] }] })), /at least 2/);
    assert.throws(
      () => loadConfig(write({ questions: [{ ...q, type: 'single', options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }] }] })),
      /duplicate option/,
    );
    assert.throws(() => loadConfig(write({ questions: [{ ...q, type: 'scale', min: 5, max: 1 }] })), /min < max/);
    assert.doesNotThrow(() => loadConfig(write({ questions: [q] })));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('single choice accepts only listed options', () => {
  const q = byId('feedback_channel');
  assert.deepEqual(validateAnswer(q, 'in_app_survey'), { ok: true, value: 'in_app_survey' });
  assert.equal(validateAnswer(q, 'martian').ok, false);
  assert.equal(validateAnswer(q, ['in_app_survey']).ok, false);
  assert.equal(validateAnswer(q, 3).ok, false);
  assert.equal(validateAnswer(q, null).ok, false, 'required question cannot be cleared');
});

test('multi choice: unique, listed, within maxSelect', () => {
  const q = byId('news_channel');
  assert.deepEqual(validateAnswer(q, ['email', 'email', 'website']), { ok: true, value: ['email', 'website'] });
  assert.equal(validateAnswer(q, ['email', 'martian']).ok, false);
  assert.equal(validateAnswer(q, 'email').ok, false);
  assert.equal(validateAnswer(q, []).ok, false, 'required: empty selection is not an answer');
  assert.equal(validateAnswer({ ...q, maxSelect: 1 }, ['email', 'website']).ok, false);
});

test('scale accepts integers inside min..max only', () => {
  const nps = byId('nps');
  assert.equal(validateAnswer(nps, 0).ok, true);
  assert.equal(validateAnswer(nps, 10).ok, true);
  for (const bad of [-1, 11, 5.5, '5', NaN, true]) assert.equal(validateAnswer(nps, bad).ok, false, String(bad));
});

test('the years question is a required dropdown with the agreed ranges', () => {
  const years = byId('years_using');
  assert.equal(years.type, 'single');
  assert.equal(years.display, 'dropdown');
  assert.equal(years.required, true);
  assert.deepEqual(years.options.map((o) => o.label), ['Mazāk par gadu', '1 gads', '2 gadi', '3 gadi', '4 gadi', '5–9 gadi', '10+ gadi']);
  assert.deepEqual(validateAnswer(years, 'under_1'), { ok: true, value: 'under_1' });
  for (const bad of ['0', '11', 5, '', null, undefined, ['1']]) assert.equal(validateAnswer(years, bad).ok, false, String(bad));
});

test('loadConfig only allows dropdown on single choice, with a known display', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
  const load = (question) => {
    const file = path.join(dir, 'q.json');
    writeFileSync(file, JSON.stringify({ questions: [{ id: 'a', title: 'T', ...question }] }));
    return loadConfig(file);
  };
  try {
    assert.doesNotThrow(() => load({ type: 'single', options: opts, display: 'dropdown' }));
    assert.throws(() => load({ type: 'single', options: opts, display: 'wheel' }), /display must be/);
    assert.throws(() => load({ type: 'multi', options: opts, display: 'dropdown' }), /single/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text is trimmed, length-limited, and optional text can be cleared', () => {
  const q = byId('one_word');
  assert.deepEqual(validateAnswer(q, '  ātrs  '), { ok: true, value: 'ātrs' });
  assert.deepEqual(validateAnswer(q, '   '), { ok: true, value: null });
  assert.deepEqual(validateAnswer(q, null), { ok: true, value: null });
  assert.equal(validateAnswer(q, 'x'.repeat(41)).ok, false);
  assert.equal(validateAnswer(q, 'x'.repeat(40)).ok, true);
  assert.equal(validateAnswer(q, 42).ok, false);
  // counted in characters, not UTF-16 units: 40 emoji fit
  assert.equal(validateAnswer(q, '😀'.repeat(40)).ok, true);
});
