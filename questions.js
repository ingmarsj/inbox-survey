import { readFileSync } from 'node:fs';

export { validateAnswer, isQuestionVisible, hiddenAnsweredIds } from './public/validate.js';

const TYPES = new Set(['single', 'multi', 'scale', 'text']);

/** Loads questions.json and refuses to start on a broken config. */
export function loadConfig(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(config.questions) || config.questions.length === 0) {
    throw new Error('questions.json: "questions" must be a non-empty array');
  }
  const seen = new Set();
  for (const q of config.questions) {
    const where = `questions.json: question "${q.id}"`;
    if (!q.id || !/^[a-z0-9_]+$/.test(q.id)) throw new Error(`${where}: id must match [a-z0-9_]+`);
    if (seen.has(q.id)) throw new Error(`${where}: duplicate id`);
    seen.add(q.id);
    if (!TYPES.has(q.type)) throw new Error(`${where}: unknown type "${q.type}"`);
    if (!q.title) throw new Error(`${where}: missing title`);
    if (q.type === 'single' || q.type === 'multi') {
      if (!Array.isArray(q.options) || q.options.length < 2) throw new Error(`${where}: needs at least 2 options`);
      const values = q.options.map((o) => o.value);
      if (new Set(values).size !== values.length) throw new Error(`${where}: duplicate option values`);
      if (q.options.some((o) => !o.value || !o.label)) throw new Error(`${where}: option needs value and label`);
      if (q.display !== undefined && !['buttons', 'dropdown'].includes(q.display)) {
        throw new Error(`${where}: display must be "buttons" or "dropdown"`);
      }
      if (q.display === 'dropdown' && q.type !== 'single') throw new Error(`${where}: dropdown works with type "single" only`);
    }
    if (q.type === 'scale') {
      if (!Number.isInteger(q.min) || !Number.isInteger(q.max) || q.min >= q.max) {
        throw new Error(`${where}: scale needs integer min < max`);
      }
    }
  }
  checkVisibilityRules(config.questions);
  checkWriteIns(config.questions);
  return config;
}

/**
 * A rule may only look at an earlier question (so there are no cycles): a single-choice one for
 * "equals" / "notEquals", a multiple-choice one for "includes".
 */
function checkVisibilityRules(questions) {
  questions.forEach((q, index) => {
    const rule = q.visibleIf;
    if (rule === undefined) return;
    const where = `questions.json: question "${q.id}" visibleIf`;
    const modes = ['equals', 'notEquals', 'includes'].filter((key) => rule[key] !== undefined);
    if (modes.length !== 1) throw new Error(`${where}: use exactly one of "equals", "notEquals" or "includes"`);
    const mode = modes[0];
    const source = questions.slice(0, index).find((x) => x.id === rule.question);
    if (!source) throw new Error(`${where}: "${rule.question}" must be an earlier question`);
    const wanted = mode === 'includes' ? 'multi' : 'single';
    if (source.type !== wanted) throw new Error(`${where}: "${source.id}" must be a ${wanted === 'multi' ? 'multiple' : 'single'}-choice question for "${mode}"`);
    if (!source.options.some((o) => o.value === rule[mode])) {
      throw new Error(`${where}: "${rule[mode]}" is not an option of "${source.id}"`);
    }
  });
}

/** An "inline" question has no screen of its own: it is the text box of a "write-in" option such as "Cits". */
function checkWriteIns(questions) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const q of questions) {
    if (q.inline) {
      const where = `questions.json: question "${q.id}"`;
      if (q.type !== 'text') throw new Error(`${where}: an inline question must be a text question`);
      const owner = questions.find((p) => (p.options ?? []).some((o) => o.writeIn === q.id));
      if (!owner) throw new Error(`${where}: inline, but no option has "writeIn": "${q.id}"`);
      const option = owner.options.find((o) => o.writeIn === q.id);
      if (q.visibleIf?.question !== owner.id || q.visibleIf?.includes !== option.value) {
        throw new Error(`${where}: must have visibleIf { "question": "${owner.id}", "includes": "${option.value}" }`);
      }
    }
    for (const o of q.options ?? []) {
      if (o.writeIn === undefined) continue;
      if (q.type !== 'multi') throw new Error(`questions.json: question "${q.id}": "writeIn" works on multiple-choice options only`);
      if (!byId.get(o.writeIn)?.inline) throw new Error(`questions.json: question "${q.id}": "writeIn" must name an inline text question`);
    }
  }
}
