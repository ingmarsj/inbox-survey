/**
 * Browser-side API backed by Supabase, used by the production build on why.inbokss.com.
 *
 * It answers the same requests as server.js and demo-api.js, so app.js does not care which
 * one it talks to. Each request becomes a call to one of the survey_* functions defined in
 * supabase/schema.sql, using only the project's publishable key (never a secret key).
 */

/** How the SQL functions report problems (their exception messages) -> HTTP-like status codes. */
const ERROR_PREFIXES = [
  ['survey_not_found', 404],
  ['survey_question_not_found', 404],
  ['survey_already_submitted', 409],
  ['survey_not_on_path', 400],
  ['survey_invalid', 400],
  ['survey_unauthorized', 401],
];

function failure(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, data: { error: message, ...extra } });
}

/**
 * @param {{ url: string, key: string, fetchImpl?: typeof fetch }} options
 * @returns a function with the same contract as the fetch-based api() in app.js,
 *          plus `.rpc(name, args)` for the results page.
 */
export function createSupabaseApi({ url, key, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  const base = url.replace(/\/+$/, '');

  async function rpc(name, args = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
    } catch {
      throw Object.assign(new Error('network'), { network: true });
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: keep null */
    }
    if (res.ok) return data;

    const message = typeof data?.message === 'string' ? data.message : `HTTP ${res.status}`;
    const known = ERROR_PREFIXES.find(([prefix]) => message.startsWith(prefix));
    throw failure(known ? known[1] : res.status, message);
  }

  async function api(method, requestUrl, body) {
    const path = requestUrl.replace(/^\/+/, '').split('?')[0];
    let m;

    if (method === 'GET' && path === 'api/questions') return rpc('survey_get_config');

    if (method === 'POST' && path === 'api/submissions') return { id: await rpc('survey_create_submission') };

    if ((m = path.match(/^api\/submissions\/([^/]+)$/)) && method === 'GET') {
      return rpc('survey_get_submission', { p_id: m[1] });
    }

    if ((m = path.match(/^api\/submissions\/([^/]+)\/answers\/([^/]+)$/)) && method === 'PUT') {
      await rpc('survey_save_answer', { p_id: m[1], p_question: m[2], p_value: body?.value ?? null });
      return { ok: true };
    }

    if ((m = path.match(/^api\/submissions\/([^/]+)\/complete$/)) && method === 'POST') {
      const result = await rpc('survey_complete', { p_id: m[1] });
      if (!result?.ok) throw failure(422, 'Not all required questions are answered', { missing: result?.missing ?? [] });
      return { ok: true };
    }

    throw failure(404, 'Not found');
  }

  api.rpc = rpc;
  return api;
}
