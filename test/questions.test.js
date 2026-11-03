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
  assert.deepEqual(ids.slice(0, 3), ['age_group', 'gender', 'years_using'], 'demographics come first');
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
  const q = byId('news_frequency');
  assert.deepEqual(validateAnswer(q, 'monthly'), { ok: true, value: 'monthly' });
  assert.equal(validateAnswer(q, 'martian').ok, false);
  assert.equal(validateAnswer(q, ['monthly']).ok, false);
  assert.equal(validateAnswer(q, 3).ok, false);
  assert.equal(validateAnswer(q, null).ok, false, 'required question cannot be cleared');
});

test('multi choice: unique, listed, within maxSelect', () => {
  const q = byId('news_channel');
  assert.deepEqual(validateAnswer(q, ['email', 'email', 'social']), { ok: true, value: ['email', 'social'] });
  assert.equal(validateAnswer(q, ['email', 'martian']).ok, false);
  assert.equal(validateAnswer(q, 'email').ok, false);
  assert.equal(validateAnswer(q, []).ok, false, 'required: empty selection is not an answer');
  assert.equal(validateAnswer({ ...q, maxSelect: 1 }, ['email', 'social']).ok, false);
});

test('scale accepts integers inside min..max only', () => {
  const rec = byId('recommend');
  assert.deepEqual([rec.min, rec.max], [1, 5]);
  assert.equal(validateAnswer(rec, 1).ok, true);
  assert.equal(validateAnswer(rec, 5).ok, true);
  for (const bad of [0, 6, 5.5, '5', NaN, true]) assert.equal(validateAnswer(rec, bad).ok, false, String(bad));
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
    'age_group', 'gender', 'years_using', 'not_using_reason', 'news_channel', 'news_channel_other', 'news_frequency', 'feedback_channel',
    'feedback_ease', 'satisfaction', 'recommend', 'pain_point', 'one_word', 'anything_else',
  ]);

  // Q2: shorter labels, and the newsletter option is gone
  assert.deepEqual(byId('news_channel').options.map((o) => o.label), [
    'E-pastā', 'Ziņojums aplikācijā', 'Sociālajos medijos', 'Klātienes vai online pasākumos', 'Cits',
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
  assert.deepEqual(pathFor('not_using'), ['age_group', 'gender', 'years_using', 'not_using_reason', 'one_word', 'anything_else']);
  assert.ok(!pathFor('2').includes('not_using_reason'));
  assert.equal(pathFor('2').length, config.questions.length - 2, 'users do not see the non-user reason and the "Cits" text box until they choose it');
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
    // a question may depend on a question that is itself conditional (earlier questions only, so no cycles)
    const chained = { ...dependent({ question: 'a', equals: 'x' }), id: 'b', type: 'single', options: opts };
    assert.doesNotThrow(() => load(source, chained, { id: 'c', type: 'text', title: 'C', visibleIf: { question: 'b', equals: 'x' } }));
    // "includes" needs a multiple-choice source, "equals" a single-choice one
    const multi = { id: 'm', type: 'multi', title: 'M', options: opts };
    const includesRule = { id: 'n', type: 'text', title: 'N', visibleIf: { question: 'm', includes: 'x' } };
    assert.doesNotThrow(() => load(multi, includesRule));
    assert.throws(() => load(source, { ...includesRule, visibleIf: { question: 'a', includes: 'x' } }), /multiple-choice/);
    assert.throws(() => load(multi, { ...includesRule, visibleIf: { question: 'm', equals: 'x' } }), /single-choice/);
    assert.throws(() => load(multi, { ...includesRule, visibleIf: { question: 'm', includes: 'nope' } }), /not an option/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('demographics: age group and gender, with the agreed options', () => {
  for (const id of ['age_group', 'gender']) {
    const q = byId(id);
    assert.equal(q.type, 'single');
    assert.equal(q.required, true);
    assert.equal(q.visibleIf, undefined, 'asked of everybody, including non-users');
  }
  assert.deepEqual(byId('age_group').options.map((o) => o.label), [
    'Jaunāks par 18', '18–24', '25–34', '35–44', '45–54', '55–64', '65 un vairāk',
  ]);
  assert.deepEqual(byId('gender').options.map((o) => o.label), ['Sieviete', 'Vīrietis', 'Nevēlos norādīt']);
});

test('"how easy is it to leave feedback" uses answer options, including "no need"', () => {
  const q = byId('feedback_ease');
  assert.equal(q.type, 'single');
  assert.equal(q.title, 'Novērtējiet, cik viegli, Jūsuprāt, ir atstāt ieteikumus/atsauksmi par Inbox.lv pakalpojumiem?');
  assert.deepEqual(q.options.map((o) => o.label), [
    'Ļoti viegli', 'Drīzāk viegli', 'Grūti pateikt', 'Drīzāk grūti', 'Ļoti grūti', 'Nesaskatu nepieciešamību',
  ]);
  assert.equal(q.options.at(-1).value, 'no_need');
});

test('news channels: "Cits" lets people write their own, and some options are gone', () => {
  const q = byId('news_channel');
  assert.equal(q.type, 'multi');
  assert.deepEqual(q.options.map((o) => o.label), ['E-pastā', 'Ziņojums aplikācijā', 'Sociālajos medijos', 'Klātienes vai online pasākumos', 'Cits']);
  assert.equal(q.options.some((o) => o.value === 'website'), false, 'the website news page option was removed');
  assert.equal(q.options.at(-1).writeIn, 'news_channel_other');

  const text = byId('news_channel_other');
  assert.equal(text.type, 'text');
  assert.equal(text.inline, true, 'the text box lives inside the news question, not on its own screen');
  assert.equal(text.required, false);
  assert.deepEqual(text.visibleIf, { question: 'news_channel', includes: 'other' });
});

test('the frequency question has no weekly option', () => {
  assert.deepEqual(byId('news_frequency').options.map((o) => o.value), ['monthly', 'quarterly', 'important_only', 'not_interested']);
});

test('where to leave feedback is a multiple-choice question with the agreed options', () => {
  const q = byId('feedback_channel');
  assert.equal(q.type, 'multi');
  assert.equal(q.required, true);
  assert.deepEqual(q.options.map((o) => o.label), [
    'Īsa anketa vēstulē e-pastā', 'Sarunā ar atbalsta komandu', 'Atsauksmju forma mobīlajā aplikācijā', 'Sociālajos medijos',
  ]);
  assert.deepEqual(validateAnswer(q, ['email_survey', 'social']), { ok: true, value: ['email_survey', 'social'] });
  assert.equal(validateAnswer(q, 'email_survey').ok, false, 'a single value is no longer valid');
  assert.equal(validateAnswer(q, []).ok, false);
});

test('the keyboard tip is hidden on the satisfaction and recommendation scales only', () => {
  for (const id of ['satisfaction', 'recommend']) assert.equal(byId(id).keyHint, false, id);
  for (const q of config.questions.filter((x) => !['satisfaction', 'recommend'].includes(x.id))) {
    assert.notEqual(q.keyHint, false, q.id);
  }
});

test('there is no 0-10 scale any more: every scale is 1-5', () => {
  const scales = config.questions.filter((q) => q.type === 'scale');
  assert.ok(scales.length >= 2);
  for (const q of scales) assert.deepEqual([q.min, q.max], [1, 5], q.id);
});

test('"Jūs", "Jums" and "Jūsu" always start with a capital letter', () => {
  const texts = [];
  const collect = (value) => {
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => k !== 'id' && k !== 'value' && collect(v));
  };
  collect(config.intro);
  collect(config.thanks);
  collect(config.questions);
  assert.ok(texts.some((t) => /\bJūs\b|\bJums\b|\bJūsu\b/.test(t)), 'the survey does address people with a capital letter');
  for (const text of texts) assert.doesNotMatch(text, /\b(jūs|jums|jūsu)\b/, text);
});

test('"includes" shows a question only when a multiple-choice answer contains the option', () => {
  const q = { id: 'b', visibleIf: { question: 'a', includes: 'x' } };
  assert.equal(isQuestionVisible(q, { a: ['x', 'y'] }), true);
  assert.equal(isQuestionVisible(q, { a: ['y'] }), false);
  assert.equal(isQuestionVisible(q, { a: [] }), false);
  assert.equal(isQuestionVisible(q, {}), false);
  assert.equal(isQuestionVisible(q, { a: 'x' }), false, 'a stale single value is not an array');
});

test('hiddenAnsweredIds drops dependent answers in cascade', () => {
  const years = { id: 'years' };
  const news = { id: 'news', visibleIf: { question: 'years', notEquals: 'not_using' } };
  const other = { id: 'other', visibleIf: { question: 'news', includes: 'other' } };
  const all = [years, news, other];

  // news gets hidden, and then the text that depended on news has to go too
  assert.deepEqual(hiddenAnsweredIds(all, { years: 'not_using', news: ['other'], other: 'My site' }), ['news', 'other']);
  assert.deepEqual(hiddenAnsweredIds(all, { years: '2', news: ['email'], other: 'My site' }), ['other']);
  assert.deepEqual(hiddenAnsweredIds(all, { years: '2', news: ['other'], other: 'My site' }), []);
});

test('write-in options are checked: they need a matching inline text question', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const options = (extra = {}) => [{ value: 'a', label: 'A' }, { value: 'other', label: 'Cits', writeIn: 'text', ...extra }];
  const multi = (opts = options()) => ({ id: 'm', type: 'multi', title: 'M', options: opts });
  const inline = (extra = {}) => ({ id: 'text', type: 'text', title: 'T', inline: true, visibleIf: { question: 'm', includes: 'other' }, ...extra });
  const load = (...questions) => {
    const file = path.join(dir, 'q.json');
    writeFileSync(file, JSON.stringify({ questions }));
    return loadConfig(file);
  };
  try {
    assert.doesNotThrow(() => load(multi(), inline()));
    assert.throws(() => load(multi()), /earlier question|writeIn/, 'the text question is missing');
    assert.throws(() => load(multi(), inline({ inline: false })), /inline/);
    assert.throws(() => load(multi(), inline({ type: 'single', options: options() })), /text question/);
    assert.throws(() => load(multi(), inline({ visibleIf: { question: 'm', includes: 'a' } })), /visibleIf/);
    assert.throws(() => load(multi(), { ...inline(), id: 'orphan', visibleIf: { question: 'm', includes: 'a' } }, inline()), /no option has/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
