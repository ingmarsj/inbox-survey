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
    assert.match(config, /backend: 'demo'/);
    assert.match(config, /questionsUrl: 'questions\.json'/);
  });
});

test('the Pages build leaves out everything that needs the server', () => {
  withBuild((dir) => {
    const files = readdirSync(dir, { recursive: true }).map(String);
    assert.ok(!files.some((f) => /results|stats|token.js|ui.js/.test(f)), 'no results or statistics page');
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

test('the checked-in config.js uses the Node server backend', () => {
  const source = readFileSync(new URL('../public/config.js', import.meta.url), 'utf8');
  assert.match(source, /backend: 'server'/);
});

test('the statistics page has a filter for every demographic question, and the support KPI', () => {
  const html = readFileSync(new URL('../public/stats/index.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../public/stats.js', import.meta.url), 'utf8');
  for (const id of ['f-age', 'f-gender', 'f-region']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} select`);
    assert.match(html, new RegExp(`id="${id}-wrap"`), `${id} wrapper`);
  }
  assert.match(script, /fill\('f-region', 'f-region-wrap', 'region'/);
  assert.match(script, /region: \$\('f-region'\)\.value/);
  assert.match(script, /'f-region'\]\)/, 'the region select re-renders the answers');
  assert.match(script, /average\('support_rating'\)/);
  // every question the filters and KPIs rely on exists in the survey
  const ids = JSON.parse(readFileSync(new URL('../questions.json', import.meta.url), 'utf8')).questions.map((q) => q.id);
  for (const id of ['age_group', 'gender', 'region', 'satisfaction', 'recommend', 'support_rating']) assert.ok(ids.includes(id), id);
});
