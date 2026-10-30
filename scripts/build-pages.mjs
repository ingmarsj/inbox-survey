// Builds the static demo that is published on GitHub Pages.
//
// GitHub Pages only serves static files, so there is no server and no SQLite there.
// The demo therefore runs the survey against an in-browser API (public/demo-api.js)
// and does not store answers anywhere. The results page is left out on purpose.
//
// Usage: node scripts/build-pages.mjs [outDir]   (default: dist)

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Front-end files that must not be published: they need the real server. */
const SERVER_ONLY = new Set(['results.html', 'results.js']);

export function buildPages(outDir = path.join(ROOT, 'dist')) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  cpSync(path.join(ROOT, 'public'), outDir, {
    recursive: true,
    filter: (source) => !SERVER_ONLY.has(path.basename(source)),
  });

  // The demo reads the same question file the server uses.
  cpSync(path.join(ROOT, 'questions.json'), path.join(outDir, 'questions.json'));

  // Switch the front end to demo mode.
  writeFileSync(
    path.join(outDir, 'config.js'),
    "window.SURVEY_CONFIG = { demo: true, questionsUrl: 'questions.json' };\n",
  );

  // Tell GitHub Pages not to run Jekyll over the files.
  writeFileSync(path.join(outDir, '.nojekyll'), '');

  if (!existsSync(path.join(outDir, 'index.html'))) throw new Error('Build failed: index.html is missing');
  return outDir;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const out = buildPages(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(`GitHub Pages demo built in ${out}`);
}
