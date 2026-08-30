import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishScheduledContent } from './publish-scheduled';

const now = new Date('2026-08-30T12:00:00+08:00');

function article(options: { image?: string; tag: string; title: string }) {
  return `---
title: ${options.title}
description: 这是一段用于定时发布验证的完整内容摘要。
date: '2026-08-29T10:00:00+08:00'
updatedDate: '2026-08-29T10:00:00+08:00'
publicationStatus: ready
scheduledAt: '2026-08-30T11:00:00+08:00'
draft: true
tags: [${options.tag}]
${options.image ? `heroImage: '${options.image}'\nheroImageAlt: 内容封面\n` : ''}---

# ${options.title}

这是可以正常发布的正文内容。
`;
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'goumin-scheduled-publish-'));
  await Promise.all([
    mkdir(join(root, 'src/content/blog'), { recursive: true }),
    mkdir(join(root, 'src/content/taxonomies/tags'), { recursive: true }),
    mkdir(join(root, 'src/content/taxonomies/categories'), { recursive: true }),
    mkdir(join(root, 'src/content/taxonomies/series'), { recursive: true }),
    mkdir(join(root, 'src/assets/images/content'), { recursive: true }),
  ]);
  await writeFile(
    join(root, 'src/content/taxonomies/tags/已登记.yaml'),
    'title: 已登记\ndescription: 可用标签\n',
    'utf8',
  );
  await writeFile(join(root, 'src/assets/images/content/cover.png'), 'image', 'utf8');
  return root;
}

describe('定时发布批次', () => {
  test('任意到期内容无效时所有文件保持不变', async () => {
    const root = await createRepository();
    const firstPath = join(root, 'src/content/blog/first.md');
    const secondPath = join(root, 'src/content/blog/second.md');
    const first = article({
      title: '第一篇文章',
      tag: '已登记',
      image: '@assets/images/content/cover.png',
    });
    const second = article({
      title: '第二篇文章',
      tag: '未登记',
      image: '@assets/images/content/missing.png',
    });
    try {
      await Promise.all([
        writeFile(firstPath, first, 'utf8'),
        writeFile(secondPath, second, 'utf8'),
      ]);

      let failure: unknown;
      try {
        await publishScheduledContent(root, now);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('预检失败');
      expect((failure as Error).message).toContain('tags 引用了未登记项：未登记');
      expect((failure as Error).message).toContain('heroImage 文件不存在');
      expect(await readFile(firstPath, 'utf8')).toBe(first);
      expect(await readFile(secondPath, 'utf8')).toBe(second);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('有效批次在预检后一次发布', async () => {
    const root = await createRepository();
    const paths = [
      join(root, 'src/content/blog/first.md'),
      join(root, 'src/content/blog/second.md'),
    ];
    try {
      await Promise.all(
        paths.map((path, index) =>
          writeFile(
            path,
            article({
              title: index === 0 ? '第一篇文章' : '第二篇文章',
              tag: '已登记',
              image: '@assets/images/content/cover.png',
            }),
            'utf8',
          ),
        ),
      );

      const published = await publishScheduledContent(root, now);
      expect(published).toHaveLength(2);
      for (const path of paths) {
        const source = await readFile(path, 'utf8');
        expect(source).toContain('publicationStatus: published');
        expect(source).toContain('draft: false');
        expect(source).not.toContain('scheduledAt:');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
