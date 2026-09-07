// Watch-mode dev build: rebuilds popup / content / background into dist/ on change.
// Load dist/ as an unpacked extension, then hit the reload button in chrome://extensions.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const TASKS = [
  { name: 'popup', args: ['vite', 'build', '--watch'] },
  { name: 'content', args: ['vite', 'build', '--watch', '--config', 'vite.content.config.ts'] },
  { name: 'background', args: ['vite', 'build', '--watch', '--config', 'vite.background.config.ts'] },
];

const children = [];

function run(task, extraEnv = {}) {
  const child = spawn(npx, task.args, {
    cwd: ROOT,
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  const tag = `[${task.name}]`;
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) out.write(`${tag} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  children.push(child);
  return child;
}

// The popup build owns emptyOutDir, so let it finish one pass before the others start
// writing into dist/.
const popup = run(TASKS[0], { DM_FIRST: '1' });
let started = false;
popup.stdout.on('data', (d) => {
  if (!started && /built in|watching for file changes/i.test(String(d))) {
    started = true;
    run(TASKS[1]);
    run(TASKS[2]);
    spawn(process.execPath, [resolve(ROOT, 'scripts/copy-static.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
});

const shutdown = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
