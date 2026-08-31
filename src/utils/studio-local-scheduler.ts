import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type StudioLocalSchedulerState = {
  error?: string;
  lastFinishedAt: string;
  lastStartedAt: string;
  phase: 'idle' | 'running' | 'error';
  published: Array<{ collection: string; slug: string }>;
  schemaVersion: 1;
  targetSha?: string;
};

function path() {
  return resolve(
    process.cwd(),
    process.env.STUDIO_RUNTIME_DIR || '.studio/runtime',
    'scheduler-state.json',
  );
}

export async function writeStudioLocalSchedulerState(state: StudioLocalSchedulerState) {
  const target = path();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export async function readStudioLocalSchedulerState() {
  try {
    return JSON.parse(await readFile(path(), 'utf8')) as StudioLocalSchedulerState;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
