// Copies manifest.json + public/** into dist/ after the three vite builds.
import { cpSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

mkdirSync(DIST, { recursive: true });

copyFileSync(resolve(ROOT, 'manifest.json'), resolve(DIST, 'manifest.json'));

const PUBLIC = resolve(ROOT, 'public');
if (existsSync(PUBLIC)) {
  cpSync(PUBLIC, DIST, { recursive: true });
}

console.log('static assets -> dist/');
