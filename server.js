import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb, createSubmission, getSubmission, saveAnswer, completeSubmission, getMeta, setMeta,
} from './db.js';
import { loadConfig, validateAnswer } from './questions.js';
import { aggregate, toCsv } from './results.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sameToken(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/**
 * Builds the survey server. Nothing is listening until you call server.listen().
 * @param {{dbPath?: string, questionsPath?: string, adminToken?: string}} options
 */
export function createApp({ dbPath = path.join(ROOT, 'data', 'survey.db'), questionsPath = path.join(ROOT, 'questions.json'), adminToken } = {}) {
  const config = loadConfig(questionsPath);
  const questionsById = new Map(config.questions.map((q) => [q.id, q]));
  const db = openDb(dbPath);

  // The results link needs a stable secret: env var, else generated once and kept in the DB.
  let token = adminToken ?? process.env.ADMIN_TOKEN ?? getMeta(db, 'admin_token');
  if (!token) token = randomBytes(18).toString('base64url');
  if (getMeta(db, 'admin_token') !== token) setMeta(db, 'admin_token', token);

  const requireAdmin = (url, req) => {
    const given = url.searchParams.get('token') ?? req.headers['x-admin-token'];
    if (!sameToken(given, token)) throw new HttpError(401, 'Unauthorized');
  };

  const requireSubmission = (id) => {
    if (!UUID.test(id)) throw new HttpError(404, 'Not found');
    const sub = getSubmission(db, id);
    if (!sub) throw new HttpError(404, 'Not found');
    return sub;
  };

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    let m;

    if (method === 'GET' && pathname === '/api/questions') {
      return send(res, 200, { intro: config.intro, thanks: config.thanks, questions: config.questions });
    }

    if (method === 'POST' && pathname === '/api/submissions') {
      const id = randomUUID();
      createSubmission(db, id);
      return send(res, 201, { id });
    }

    if ((m = pathname.match(/^\/api\/submissions\/([^/]+)$/)) && method === 'GET') {
      const sub = requireSubmission(m[1]);
      return send(res, 200, { id: sub.id, completed: Boolean(sub.completedAt), answers: sub.answers });
    }

    if ((m = pathname.match(/^\/api\/submissions\/([^/]+)\/answers\/([^/]+)$/)) && method === 'PUT') {
      const sub = requireSubmission(m[1]);
      const question = questionsById.get(m[2]);
      if (!question) throw new HttpError(404, 'Question not found');
      if (sub.completedAt) throw new HttpError(409, 'Survey already submitted');
      const body = await readJson(req);
      const result = validateAnswer(question, body.value);
      if (!result.ok) throw new HttpError(400, result.error);
      saveAnswer(db, sub.id, question.id, result.value);
      return send(res, 200, { ok: true });
    }

    if ((m = pathname.match(/^\/api\/submissions\/([^/]+)\/complete$/)) && method === 'POST') {
      const sub = requireSubmission(m[1]);
      const missing = config.questions
        .filter((q) => q.required && sub.answers[q.id] === undefined)
        .map((q) => q.id);
      if (missing.length) throw new HttpError(422, 'Not all required questions are answered', { missing });
      completeSubmission(db, sub.id);
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/results') {
      requireAdmin(url, req);
      return send(res, 200, aggregate(db, config));
    }

    if (method === 'GET' && pathname === '/api/export.csv') {
      requireAdmin(url, req);
      return send(res, 200, toCsv(db, config), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="aptauja.csv"',
      });
    }

    throw new HttpError(404, 'Not found');
  }

  async function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/results') pathname = '/results.html';
    const file = path.join(PUBLIC_DIR, pathname);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');
    let data;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      // The pages only talk to this origin and run only their own scripts.
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handleStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      console.error(err);
      send(res, 500, { error: 'Server error' });
    }
  });

  server.on('close', () => db.close());
  return { server, db, adminToken: token };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const { server, adminToken } = createApp({ dbPath: process.env.DB_PATH });
  server.listen(port, () => {
    console.log(`Survey:      http://localhost:${port}/`);
    console.log(`Results:     http://localhost:${port}/results?token=${adminToken}`);
    console.log(`CSV export:  http://localhost:${port}/api/export.csv?token=${adminToken}`);
  });
}
