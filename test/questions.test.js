import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, validateAnswer, isQuestionVisible, hiddenAnsweredIds } from '../questions.js';
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
  assert.deepEqual(years.options.map((o) => o.label), ['Nelietoju', 'Mazāk par gadu', '1 gads', '2 gadi', '3 gadi', '4 gadi', '5–9 gadi', '10+ gadi']);
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

test('the shipped survey follows the marketing wording and order', () => {
  const ids = config.questions.map((q) => q.id);
  assert.deepEqual(ids, [
    'years_using', 'not_using_reason', 'news_channel', 'news_frequency', 'feedback_channel',
    'feedback_ease', 'satisfaction', 'nps', 'pain_point', 'one_word', 'anything_else',
  ]);

  // Q2: shorter labels, and the newsletter option is gone
  assert.deepEqual(byId('news_channel').options.map((o) => o.label), [
    'E-pastā', 'Ziņojums lietotnē', 'Jaunumu lapā mājaslapā', 'Sociālajos medijos', 'Klātienes vai online pasākumos',
  ]);
  assert.equal(byId('news_channel').options.some((o) => o.value === 'newsletter'), false);
  // Q3: people can say they are not interested in news
  assert.equal(byId('news_frequency').options.at(-1).label, 'Neinteresē Inbox.lv jaunumi');

  // The product is called Inbox.lv everywhere
  for (const q of config.questions) {
    const text = [q.title, q.hint, ...(q.options ?? []).map((o) => o.label)].filter(Boolean).join(' ');
    assert.doesNotMatch(text, /\bInbox(?!\.lv)\b/, q.id);
    assert.doesNotMatch(text, /produkt/i, q.id);
  }
  assert.doesNotMatch(config.thanks.subtitle, /\bInbox(?!\.lv)\b/);

  // Free-text sections: associations and experience, with experience before associations
  assert.equal(byId('one_word').section, 'Asociācijas');
  assert.equal(byId('pain_point').section, 'Pieredze');
  assert.ok(ids.indexOf('pain_point') < ids.indexOf('one_word'));
  assert.ok(!config.questions.some((q) => q.section === 'Jūsu vārdi'));
});

test('people who do not use Inbox.lv get a short path; users do not see the "why not" question', () => {
  const pathFor = (years) => config.questions.filter((q) => isQuestionVisible(q, { years_using: years })).map((q) => q.id);
  assert.deepEqual(pathFor('not_using'), ['years_using', 'not_using_reason', 'one_word', 'anything_else']);
  assert.ok(!pathFor('2').includes('not_using_reason'));
  assert.equal(pathFor('2').length, config.questions.length - 1);
  // before the first answer everything regular is shown, and the non-user question is not
  assert.ok(!config.questions.filter((q) => isQuestionVisible(q, {})).map((q) => q.id).includes('not_using_reason'));
  assert.equal(byId('not_using_reason').required, false);
  assert.equal(byId('not_using_reason').type, 'text');
});

test('isQuestionVisible and hiddenAnsweredIds', () => {
  const equals = { id: 'b', visibleIf: { question: 'a', equals: 'x' } };
  const notEquals = { id: 'c', visibleIf: { question: 'a', notEquals: 'x' } };
  const plain = { id: 'd' };
  assert.equal(isQuestionVisible(plain, {}), true);
  assert.equal(isQuestionVisible(equals, { a: 'x' }), true);
  assert.equal(isQuestionVisible(equals, { a: 'y' }), false);
  assert.equal(isQuestionVisible(equals, {}), false);
  assert.equal(isQuestionVisible(notEquals, {}), true);
  assert.equal(isQuestionVisible(notEquals, { a: 'x' }), false);
  assert.equal(isQuestionVisible(notEquals, { a: 'y' }), true);

  const all = [{ id: 'a' }, equals, notEquals, plain];
  assert.deepEqual(hiddenAnsweredIds(all, { a: 'x', b: 1, c: 2, d: 3 }), ['c']);
  assert.deepEqual(hiddenAnsweredIds(all, { a: 'y', b: 1, c: 2, d: 3 }), ['b']);
  assert.deepEqual(hiddenAnsweredIds(all, { a: 'x' }), []);
});

test('loadConfig validates visibleIf rules', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const opts = [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }];
  const source = { id: 'a', type: 'single', title: 'A', options: opts };
  const load = (...questions) => {
    const file = path.join(dir, 'q.json');
    writeFileSync(file, JSON.stringify({ questions }));
    return loadConfig(file);
  };
  const dependent = (visibleIf) => ({ id: 'b', type: 'text', title: 'B', visibleIf });
  try {
    assert.doesNotThrow(() => load(source, dependent({ question: 'a', equals: 'x' })));
    assert.doesNotThrow(() => load(source, dependent({ question: 'a', notEquals: 'y' })));
    assert.throws(() => load(source, dependent({ question: 'a' })), /exactly one/);
    assert.throws(() => load(source, dependent({ question: 'a', equals: 'x', notEquals: 'y' })), /exactly one/);
    assert.throws(() => load(source, dependent({ question: 'zzz', equals: 'x' })), /earlier question/);
    assert.throws(() => load(dependent({ question: 'a', equals: 'x' }), source), /earlier question/);
    assert.throws(() => load(source, dependent({ question: 'a', equals: 'nope' })), /not an option/);
    assert.throws(() => load({ id: 'a', type: 'text', title: 'A' }, dependent({ question: 'a', equals: 'x' })), /single-choice/);
    const chained = { ...dependent({ question: 'a', equals: 'x' }), id: 'b', type: 'single', options: opts };
    assert.throws(() => load(source, chained, { id: 'c', type: 'text', title: 'C', visibleIf: { question: 'b', equals: 'x' } }), /conditional itself/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
