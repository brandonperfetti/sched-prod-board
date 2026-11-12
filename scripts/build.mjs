// Builds dist/ from app/: stamps the git sha (R6) and writes config.js from BOARD_API and BOARD_SESSION.
// Refuses a dirty tree, so the sha on the page is always the commit that built it.
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain') && !process.env.ALLOW_DIRTY) {
  console.error('build: the tree has uncommitted changes; commit first so the sha names this build');
  process.exit(1);
}
const sha = git('rev-parse', 'HEAD');
const { BOARD_API, BOARD_SESSION } = process.env;
if (!BOARD_API || !BOARD_SESSION) {
  console.error('build: set BOARD_API and BOARD_SESSION');
  process.exit(1);
}

rmSync('dist', { recursive: true, force: true });
cpSync('app', 'dist', { recursive: true });
const html = readFileSync('dist/index.html', 'utf8').replaceAll('__BUILD_SHA__', sha);
writeFileSync('dist/index.html', html);
writeFileSync(
  'dist/config.js',
  `export const API = ${JSON.stringify(BOARD_API)};\nexport const SESSION = ${JSON.stringify(BOARD_SESSION)};\n`,
);
console.log(`build: dist/ at ${sha}`);
