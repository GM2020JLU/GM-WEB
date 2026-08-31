#!/usr/bin/env bun

import { publishScheduledContent } from './publish-scheduled';
import {
  cancelStudioLocalDeploymentIntent,
  commitStudioLocalDeploymentIntent,
  prepareStudioLocalDeploymentIntent,
} from '../src/utils/studio-local-deployment';
import { writeStudioLocalSchedulerState } from '../src/utils/studio-local-scheduler';
import {
  acquireStudioRuntimeLease,
  withStudioContentFileLock,
} from '../src/utils/studio-runtime-lock';

const startedAt = new Date().toISOString();
const lease = await acquireStudioRuntimeLease({
  name: 'scheduled-publisher',
  purpose: '本地定时发布',
  staleMs: 10 * 60 * 1000,
  timeoutMs: 5_000,
});

try {
  await writeStudioLocalSchedulerState({
    lastFinishedAt: startedAt,
    lastStartedAt: startedAt,
    phase: 'running',
    published: [],
    schemaVersion: 1,
  });
  let targetSha: string | undefined;
  const published = await withStudioContentFileLock(async () => {
    // Journal the deploy intent before touching content. Prepared intents are
    // intentionally replayable after SIGKILL, so no scheduled publication can
    // become visible locally without eventually reaching the deploy worker.
    const intentId = await prepareStudioLocalDeploymentIntent('定时发布到期内容');
    try {
      const changed = await publishScheduledContent(process.cwd(), new Date(), async () => {
        await commitStudioLocalDeploymentIntent(intentId);
        targetSha = intentId;
      });
      if (!changed.length) {
        await cancelStudioLocalDeploymentIntent(intentId);
        return changed;
      }
      return changed;
    } catch (error) {
      // publishScheduledContent attempts a rollback, but a second filesystem
      // failure can make that rollback partial. Preserve the prepared journal so
      // the worker deploys whatever state is actually durable on disk.
      throw error;
    }
  });
  await writeStudioLocalSchedulerState({
    lastFinishedAt: new Date().toISOString(),
    lastStartedAt: startedAt,
    phase: 'idle',
    published: published.map(({ collection, slug }) => ({ collection, slug })),
    schemaVersion: 1,
    targetSha,
  });
  console.log(`本地定时发布检查完成：${published.length} 项。`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeStudioLocalSchedulerState({
    error: message,
    lastFinishedAt: new Date().toISOString(),
    lastStartedAt: startedAt,
    phase: 'error',
    published: [],
    schemaVersion: 1,
  });
  console.error(message);
  process.exitCode = 1;
} finally {
  await lease.release();
}
