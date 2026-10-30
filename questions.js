import { readFileSync } from 'node:fs';

export { validateAnswer } from './public/validate.js';

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
  return config;
}
