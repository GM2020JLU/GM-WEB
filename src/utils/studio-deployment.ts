export type StudioDeploymentPhase = 'submitted' | 'queued' | 'building' | 'ready' | 'error';

export interface StudioDeploymentState {
  phase: StudioDeploymentPhase;
  provider?: 'local' | 'vercel';
  targetSha: string;
  runtimeSha?: string;
  repositorySha?: string;
  deploymentSha?: string;
  updatedAt?: string;
  logUrl?: string;
}

export interface PendingStudioDeployment {
  publicUrl?: string;
  startedAt: string;
  targetSha: string;
  title: string;
}

export const STUDIO_DEPLOYMENT_STORAGE_KEY = 'gm-studio-pending-deployment';

export function resolveStudioDeploymentPhase(input: {
  commitState?: string;
  deploymentSha?: string;
  deploymentState?: string;
  repositorySha?: string;
  runtimeSha?: string;
  targetSha: string;
}): StudioDeploymentPhase {
  if (input.runtimeSha === input.targetSha) return 'ready';
  if (['error', 'failure'].includes(input.commitState ?? '')) return 'error';
  if (
    input.deploymentSha === input.targetSha &&
    ['error', 'failure'].includes(input.deploymentState ?? '')
  ) {
    return 'error';
  }
  if (input.deploymentSha === input.targetSha || input.commitState === 'pending') return 'building';
  if (input.repositorySha === input.targetSha) return 'queued';
  return 'submitted';
}

export function deploymentCopy(state: StudioDeploymentState) {
  const isLocal = state.provider === 'local';
  if (state.phase === 'ready') {
    return {
      title: '网站已上线',
      detail: isLocal ? 'Mac 已切换到这次发布。' : '生产域名已经切换到这次发布。',
      progress: 100,
    };
  }
  if (state.phase === 'error') {
    return { title: '部署失败', detail: '内容已保存，但构建没有成功。', progress: 100 };
  }
  if (state.phase === 'building') {
    return {
      title: '正在构建网站',
      detail: isLocal
        ? 'Mac 正在检查内容并生成页面，通常需要约 45—90 秒。'
        : 'Vercel 正在生成页面，通常需要约 30—90 秒。',
      progress: 68,
    };
  }
  if (state.phase === 'queued') {
    return {
      title: '等待开始构建',
      detail: isLocal
        ? '内容已进入 Mac 本地发布队列。'
        : 'GitHub 已收到内容，正在等待 Vercel 接手。',
      progress: 38,
    };
  }
  return {
    title: '发布已提交',
    detail: isLocal ? '内容已经保存到 Mac。' : '内容已经保存到 GitHub。',
    progress: 16,
  };
}

export function readPendingDeployment(storage: Pick<Storage, 'getItem'>) {
  try {
    const value = storage.getItem(STUDIO_DEPLOYMENT_STORAGE_KEY);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as PendingStudioDeployment;
    if (!/^[a-f0-9]{40}$/i.test(parsed.targetSha) || !parsed.startedAt) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
