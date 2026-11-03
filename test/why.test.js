import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWhy, checkProject, PROJECT_FILE } from '../scripts/build-why.mjs';

const project = JSON.parse(readFileSync(PROJECT_FILE, 'utf8'));

function withBuild(run, theProject) {
  const dir = mkdtempSync(path.join(tmpdir(), 'why-'));
  try {
    buildWhy(dir, theProject);
    return run(path.join(dir, 'inbox-survey'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8');

test('the checked-in project settings are public values only', () => {
  assert.doesNotThrow(() => checkProject(project));
  assert.match(project.url, /^https:\/\/[a-z0-9]+\.supabase\.co$/);
  assert.ok(project.publishableKey.startsWith('sb_publishable_'));
});

test('secret keys and strange URLs are refused', () => {
  const bad = [
    { ...project, publishableKey: 'sb_secret_abc' },
    { ...project, publishableKey: '' },
    { ...project, publishableKey: undefined },
    { ...project, publishableKey: 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"role":"service_role"}').toString('base64url') + '.sig' },
    { ...project, url: 'http://abc.supabase.co' },
    { ...project, url: 'https://evil.example.com' },
    { ...project, url: undefined },
  ];
  for (const candidate of bad) assert.throws(() => checkProject(candidate), /supabase\/project\.json/, JSON.stringify(candidate).slice(0, 80));
  // the legacy anon key is a JWT with role "anon" and is fine
  const anon = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"role":"anon"}').toString('base64url') + '.sig';
  assert.doesNotThrow(() => checkProject({ ...project, publishableKey: anon }));
});

test('the build puts everything in an inbox-survey/ folder with the Supabase backend', () => {
  withBuild((dir, root) => {
    assert.deepEqual(readdirSync(root), ['inbox-survey']);
    for (const file of ['index.html', 'results.html', 'app.js', 'results.js', 'aggregate.js', 'validate.js', 'supabase-api.js', 'style.css', 'config.js']) {
      assert.ok(existsSync(path.join(dir, file)), file);
    }
    for (const logo of ['img/inbox.png', 'img/inbox-white.png']) assert.ok(existsSync(path.join(dir, logo)), logo);

    const config = read(dir, 'config.js');
    assert.match(config, /"backend": "supabase"/);
    assert.ok(config.includes(project.url));
    assert.ok(config.includes(project.publishableKey));
  });
});

test('nothing that needs the Node server, SQLite or a secret is published', () => {
  withBuild((dir) => {
    const files = readdirSync(dir, { recursive: true }).map((f) => String(f).replaceAll('\\', '/'));
    for (const forbidden of ['server.js', 'db.js', 'questions.js', 'questions.json', 'demo-api.js']) {
      assert.ok(!files.includes(forbidden), `${forbidden} is not published`);
    }
    assert.ok(!files.some((f) => /\.(db|sql)$/.test(f)));
    for (const file of files.filter((f) => /\.(js|html)$/.test(f))) {
      const text = read(dir, file);
      assert.doesNotMatch(text, /sb_secret_|service_role|SUPABASE_SERVICE/i, file);
    }
  });
});

test('every asset is referenced relatively and exists, so the folder works under /inbox-survey/', () => {
  withBuild((dir) => {
    for (const page of ['index.html', 'results.html']) {
      const html = read(dir, page);
      const refs = [...html.matchAll(/(?:src|href|srcset)="([^"#]+)"/g)].map((m) => m[1]);
      assert.ok(refs.length >= 4, page);
      for (const ref of refs) {
        assert.ok(!ref.startsWith('/'), `${page}: ${ref} must not be root-absolute`);
        if (ref === './') continue;
        assert.ok(existsSync(path.join(dir, ref)), `${page}: ${ref} exists`);
      }
    }
    assert.doesNotMatch(read(dir, 'app.js'), /['"`]\/api\//);
  });
});

test('both pages are kept out of search engines and load the config before the app', () => {
  withBuild((dir) => {
    for (const page of ['index.html', 'results.html']) {
      const html = read(dir, page);
      assert.match(html, /<meta name="robots" content="noindex">/, page);
      assert.ok(html.indexOf('config.js') < html.indexOf('app.js') || page === 'results.html', page);
    }
    const results = read(dir, 'results.html');
    assert.ok(results.indexOf('config.js') < results.indexOf('results.js'));
  });
});

test('the build is repeatable and cleans its folder first', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'why-'));
  try {
    buildWhy(dir);
    buildWhy(dir);
    assert.ok(existsSync(path.join(dir, 'inbox-survey', 'index.html')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
