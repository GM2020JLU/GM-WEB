import { describe, expect, test } from 'bun:test';
import {
  assertStudioBulkRevision,
  assertUniqueStudioBulkItems,
  studioBulkNeedsDeployment,
  studioBulkStatusByAction,
} from './studio-bulk';

describe('Studio 批量操作', () => {
  test('发布以及把已发布内容转为草稿或待发布都会触发部署', () => {
    expect(studioBulkNeedsDeployment(studioBulkStatusByAction.publish, ['draft'])).toBe(true);
    expect(studioBulkNeedsDeployment(studioBulkStatusByAction.draft, ['published'])).toBe(true);
    expect(studioBulkNeedsDeployment(studioBulkStatusByAction.ready, ['published'])).toBe(true);
  });

  test('纯草稿状态整理不触发部署', () => {
    expect(studioBulkNeedsDeployment(studioBulkStatusByAction.draft, ['draft', 'ready'])).toBe(
      false,
    );
  });

  test('拒绝同一条内容被重复提交', () => {
    expect(() =>
      assertUniqueStudioBulkItems([
        { collection: 'blog', slug: 'one' },
        { collection: 'blog', slug: 'one' },
      ]),
    ).toThrow('重复');
  });

  test('拒绝使用过期列表版本覆盖较新的内容', () => {
    expect(() =>
      assertStudioBulkRevision('2026-08-29T12:00:00+08:00', '2026-08-30T12:00:00+08:00', '文章 A'),
    ).toThrow('刷新列表');
    expect(() =>
      assertStudioBulkRevision('2026-08-30T12:00:00+08:00', '2026-08-30T12:00:00+08:00', '文章 A'),
    ).not.toThrow();
    expect(() => assertStudioBulkRevision(undefined, undefined, '旧文章')).not.toThrow();
  });
});
