import type { StudioPublicationStatus } from './studio-content';

export type StudioBulkAction = 'draft' | 'ready' | 'publish' | 'unpublish';

export const studioBulkStatusByAction: Record<StudioBulkAction, StudioPublicationStatus> = {
  draft: 'draft',
  ready: 'ready',
  publish: 'published',
  unpublish: 'draft',
};

export function studioBulkNeedsDeployment(
  targetStatus: StudioPublicationStatus,
  currentStatuses: StudioPublicationStatus[],
) {
  return (
    targetStatus === 'published' ||
    currentStatuses.some((currentStatus) => currentStatus === 'published')
  );
}

export function assertUniqueStudioBulkItems(items: Array<{ collection: string; slug: string }>) {
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.collection}\0${item.slug}`;
    if (seen.has(key)) {
      throw Object.assign(new Error('批量操作中包含重复内容。'), { status: 400 });
    }
    seen.add(key);
  }
}

export function assertStudioBulkRevision(
  expectedUpdatedDate: string | undefined,
  currentUpdatedDate: unknown,
  title: string,
) {
  if (expectedUpdatedDate && String(currentUpdatedDate ?? '') !== expectedUpdatedDate) {
    throw Object.assign(new Error(`“${title}”已在其他页面更新，请刷新列表后重试。`), {
      status: 409,
    });
  }
}
