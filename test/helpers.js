import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { loadConfig } from '../questions.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const QUESTIONS_PATH = path.join(ROOT, 'questions.json');
export const config = loadConfig(QUESTIONS_PATH);
export const TOKEN = 'test-token';

/** Starts a real server on a random port with its own database. */
export async function startServer(options = {}) {
  const { dbPath = ':memory:', questionsPath = QUESTIONS_PATH } = options;
  // pass adminToken: null to let the app generate (and persist) its own
  const adminToken = options.adminToken === null ? undefined : (options.adminToken ?? TOKEN);
  const app = createApp({ dbPath, adminToken, questionsPath });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8'); // keeps a BOM, unlike res.text()
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  };

  return {
    ...app,
    base,
    call,
    async stop() {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    },
    async newSubmission() {
      return (await call('POST', '/api/submissions')).json.id;
    },
    answer: (id, qid, value) => call('PUT', `/api/submissions/${id}/answers/${qid}`, { value }),
  };
}

/** A valid answer for every question, optionally overridden. */
export function validAnswers(overrides = {}) {
  const out = {};
  for (const q of config.questions) {
    if (q.type === 'single') out[q.id] = q.options[0].value;
    else if (q.type === 'multi') out[q.id] = [q.options[0].value, q.options[1].value];
    else if (q.type === 'scale') out[q.id] = q.max;
    else out[q.id] = `Teksts: ${q.id}`;
  }
  return { ...out, ...overrides };
}

/** Raw request that keeps the path exactly as written (fetch would normalise ../). */
export function rawGet(base, rawPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    http
      .get({ hostname, port, path: rawPath }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      })
      .on('error', reject);
  });
}
