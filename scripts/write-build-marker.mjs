import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.cwd();
const explicitSha =
  process.env.NAVFOLIO_BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA;
let sha = explicitSha?.trim();
if (!sha) {
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    sha = undefined;
  }
}
if (!sha || !/^[a-f0-9]{40}$/iu.test(sha)) {
  throw new Error('无法确定本次构建的精确 Git SHA。');
}

const target = join(root, 'public', '.well-known', 'navfolio-build.json');
const temporary = `${target}.${process.pid}.tmp`;
mkdirSync(dirname(target), { recursive: true });
writeFileSync(
  temporary,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sha: sha.toLowerCase(),
      source:
        process.env.VERCEL === '1'
          ? 'vercel'
          : process.env.GITHUB_ACTIONS === 'true'
            ? 'github-actions'
            : process.env.NAVFOLIO_BUILD_SHA
              ? 'local-worker'
              : 'local',
    },
    null,
    2,
  )}\n`,
  { mode: 0o644 },
);
renameSync(temporary, target);
console.log(`构建标记：${sha}`);
