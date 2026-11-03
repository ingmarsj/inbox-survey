/**
 * Validates one answer against its question definition.
 *
 * Shared by the Node server and the in-browser demo API, so both accept
 * exactly the same answers. It must stay free of Node-only imports.
 *
 * Returns { ok: true, value } (value === null means "clear the answer")
 * or { ok: false, error }.
 */
export function validateAnswer(q, raw) {
  const fail = (error) => ({ ok: false, error });

  if (raw === null || raw === undefined) {
    return q.required ? fail('This question is required') : { ok: true, value: null };
  }

  switch (q.type) {
    case 'single': {
      if (typeof raw !== 'string' || !q.options.some((o) => o.value === raw)) return fail('Invalid answer');
      return { ok: true, value: raw };
    }
    case 'multi': {
      if (!Array.isArray(raw)) return fail('Invalid answer');
      if (raw.some((v) => typeof v !== 'string' || !q.options.some((o) => o.value === v))) return fail('Invalid answer');
      const unique = [...new Set(raw)];
      if (unique.length === 0) return q.required ? fail('This question is required') : { ok: true, value: null };
      if (unique.length > (q.maxSelect ?? q.options.length)) return fail('Too many options selected');
      return { ok: true, value: unique };
    }
    case 'scale': {
      if (!Number.isInteger(raw) || raw < q.min || raw > q.max) return fail('Invalid answer');
      return { ok: true, value: raw };
    }
    case 'text': {
      if (typeof raw !== 'string') return fail('Invalid answer');
      const text = raw.trim();
      if (text === '') return q.required ? fail('This question is required') : { ok: true, value: null };
      if ([...text].length > (q.maxLength ?? 1000)) return fail('Text is too long');
      return { ok: true, value: text };
    }
    default:
      return fail('Unknown question type');
  }
}

/**
 * True when the question is on this respondent's path, given the answers so far.
 * A question may carry `visibleIf: { question, equals }` or `{ question, notEquals }` (an earlier
 * single-choice question), or `{ question, includes }` (an earlier multiple-choice question that
 * must contain that option).
 */
export function isQuestionVisible(q, answers) {
  const rule = q.visibleIf;
  if (!rule) return true;
  const given = answers[rule.question];
  if (rule.equals !== undefined) return given === rule.equals;
  if (rule.notEquals !== undefined) return given !== rule.notEquals;
  if (rule.includes !== undefined) return Array.isArray(given) && given.includes(rule.includes);
  return true;
}

/**
 * Ids of answered questions that are no longer on the respondent's path (they must be dropped).
 * Dropping an answer can hide questions that depended on it, so this repeats until nothing changes.
 */
export function hiddenAnsweredIds(questions, answers) {
  const remaining = { ...answers };
  const hidden = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const q of questions) {
      if (remaining[q.id] !== undefined && !isQuestionVisible(q, remaining)) {
        delete remaining[q.id];
        hidden.push(q.id);
        changed = true;
      }
    }
  }
  return hidden;
}
