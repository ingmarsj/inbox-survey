import { validateAnswer } from './validate.js';

/**
 * In-browser stand-in for the survey API, used by the static GitHub Pages demo.
 *
 * It answers the same requests as server.js, but keeps everything in this
 * browser's localStorage: nothing is ever sent to a server or stored anywhere else.
 */

const STORAGE_KEY = 'inbox-survey-demo-v1';

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}

/** localStorage when it works (it throws in some private modes), otherwise a plain in-memory map. */
function defaultStorage() {
  try {
    const storage = globalThis.localStorage;
    storage.setItem('__probe', '1');
    storage.removeItem('__probe');
    return storage;
  } catch {
    return memoryStorage();
  }
}

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * @param {{ loadQuestions: () => Promise<object>, storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void } }} options
 * @returns {(method: string, url: string, body?: object) => Promise<object>} same contract as the fetch-based api() in app.js
 */
export function createDemoApi({ loadQuestions, storage = defaultStorage() }) {
  let config = null;

  const read = () => {
    try {
      return JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
    } catch {
      return {};
    }
  };
  const write = (all) => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* storage full or blocked: the demo keeps working for this page view */
    }
  };
  const failure = (status, message, extra = {}) =>
    Object.assign(new Error(message), { status, data: { error: message, ...extra } });

  return async function demoApi(method, url, body) {
    config ??= await loadQuestions();
    const path = url.replace(/^\/+/, '').split('?')[0];
    let m;

    if (method === 'GET' && path === 'api/questions') {
      return { intro: config.intro, thanks: config.thanks, questions: config.questions };
    }

    if (method === 'POST' && path === 'api/submissions') {
      const all = read();
      const id = newId();
      all[id] = { answers: {}, completed: false };
      write(all);
      return { id };
    }

    if ((m = path.match(/^api\/submissions\/([^/]+)$/)) && method === 'GET') {
      const sub = read()[m[1]];
      if (!sub) throw failure(404, 'Not found');
      return { id: m[1], completed: sub.completed, answers: sub.answers };
    }

    if ((m = path.match(/^api\/submissions\/([^/]+)\/answers\/([^/]+)$/)) && method === 'PUT') {
      const all = read();
      const sub = all[m[1]];
      if (!sub) throw failure(404, 'Not found');
      const question = config.questions.find((q) => q.id === m[2]);
      if (!question) throw failure(404, 'Question not found');
      if (sub.completed) throw failure(409, 'Survey already submitted');
      const result = validateAnswer(question, body?.value);
      if (!result.ok) throw failure(400, result.error);
      if (result.value === null) delete sub.answers[question.id];
      else sub.answers[question.id] = result.value;
      write(all);
      return { ok: true };
    }

    if ((m = path.match(/^api\/submissions\/([^/]+)\/complete$/)) && method === 'POST') {
      const all = read();
      const sub = all[m[1]];
      if (!sub) throw failure(404, 'Not found');
      const missing = config.questions.filter((q) => q.required && sub.answers[q.id] === undefined).map((q) => q.id);
      if (missing.length) throw failure(422, 'Not all required questions are answered', { missing });
      sub.completed = true;
      write(all);
      return { ok: true };
    }

    throw failure(404, 'Not found');
  };
}
