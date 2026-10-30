import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPages } from '../scripts/build-pages.mjs';

function withBuild(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pages-'));
  try {
    buildPages(dir);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8');

test('the Pages build contains the survey and switches the front end to demo mode', () => {
  withBuild((dir) => {
    for (const file of ['index.html', 'app.js', 'demo-api.js', 'validate.js', 'style.css', 'config.js', 'questions.json', '.nojekyll']) {
      assert.ok(existsSync(path.join(dir, file)), `${file} is built`);
    }
    for (const logo of ['img/inbox.png', 'img/inbox-white.png']) assert.ok(existsSync(path.join(dir, logo)), logo);

    const config = read(dir, 'config.js');
    assert.match(config, /demo: true/);
    assert.match(config, /questionsUrl: 'questions\.json'/);
  });
});

test('the Pages build leaves out everything that needs the server', () => {
  withBuild((dir) => {
    const files = readdirSync(dir, { recursive: true }).map(String);
    assert.ok(!files.some((f) => /results/.test(f)), 'no results page');
    assert.ok(!files.some((f) => /\.(db|db-wal|db-shm)$/.test(f)), 'no database files');
    assert.ok(!files.includes('server.js'));
  });
});

test('every asset the built index.html references is relative and exists (works under /<repo>/)', () => {
  withBuild((dir) => {
    const html = read(dir, 'index.html');
    const refs = [...html.matchAll(/(?:src|href|srcset)="([^"#]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 5);
    for (const ref of refs) {
      assert.ok(!ref.startsWith('/'), `${ref} must not be root-absolute`);
      if (ref === './') continue;
      assert.ok(existsSync(path.join(dir, ref)), `${ref} exists in the build`);
    }
  });
});

test('the front end never calls the API with a root-absolute path', () => {
  withBuild((dir) => {
    assert.doesNotMatch(read(dir, 'app.js'), /['"`]\/api\//);
  });
});

test('the build is repeatable and cleans the output folder first', () => {
  withBuild((dir) => {
    buildPages(dir);
    buildPages(dir);
    assert.ok(existsSync(path.join(dir, 'index.html')));
  });
});

test('the checked-in config.js keeps demo mode OFF for the real server', () => {
  const source = readFileSync(new URL('../public/config.js', import.meta.url), 'utf8');
  assert.match(source, /demo: false/);
});
