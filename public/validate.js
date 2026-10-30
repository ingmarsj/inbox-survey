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
