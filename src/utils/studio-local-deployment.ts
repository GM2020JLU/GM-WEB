import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { StudioDeploymentState } from './studio-deployment';

const JOB_PATTERN = /^[a-f0-9]{40}$/;

function runtimeRoot() {
  return resolve(process.cwd(), process.env.STUDIO_RUNTIME_DIR || '.studio/runtime');
}

function statePath(targetSha: string) {
  if (!JOB_PATTERN.test(targetSha)) throw new Error('部署任务标识不合法。');
  return resolve(runtimeRoot(), 'deployments', `${targetSha}.json`);
}

async function writeState(state: StudioDeploymentState) {
  const path = statePath(state.targetSha);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function startStudioLocalDeployment(reason: string) {
  const targetSha = randomBytes(20).toString('hex');
  await writeState({
    phase: 'queued',
    provider: 'local',
    targetSha,
    updatedAt: new Date().toISOString(),
  });

  const worker = resolve(process.cwd(), 'scripts/local-deploy.ts');
  const child = spawn(process.env.STUDIO_BUN_PATH || 'bun', [worker, targetSha, reason], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: 'ignore',
  });
  child.unref();
  return targetSha;
}

export async function readStudioLocalDeployment(
  targetSha?: string,
): Promise<StudioDeploymentState> {
  if (!targetSha) {
    return {
      phase: 'ready',
      provider: 'local',
      targetSha: '0'.repeat(40),
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    return JSON.parse(await readFile(statePath(targetSha), 'utf8')) as StudioDeploymentState;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
      throw Object.assign(new Error('找不到本地部署任务。'), { status: 404 });
    }
    throw error;
  }
}

export const localDeploymentState = { writeState };
