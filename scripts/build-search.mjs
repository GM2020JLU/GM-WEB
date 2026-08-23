import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { getBuildOutputDirectory } from './build-output.mjs';

const root = process.cwd();
const output = getBuildOutputDirectory(root);
const pagefind = join(root, 'node_modules', '.bin', 'pagefind');
const result = spawnSync(
  pagefind,
  [
    '--site',
    output,
    '--output-subdir',
    'pagefind',
    '--root-selector',
    'main',
    '--exclude-selectors',
    '[data-pagefind-ignore]',
  ],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
