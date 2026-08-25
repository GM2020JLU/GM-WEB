import { describe, expect, test } from 'bun:test';
import { auditDocuments, parseDocument, publicationStatus } from '../scripts/lib/content-audit.mjs';
import {
  countWords,
  estimateReadingMinutes,
  getPublicationStatus,
} from '../src/utils/content-metrics';

const taxonomies = {
  tags: new Set(['Astro']),
  categories: new Set(['站点日志']),
  series: new Set(),
};

describe('发布状态', () => {
  test('兼容旧 draft 字段', () => {
    expect(publicationStatus({ draft: true })).toBe('draft');
    expect(getPublicationStatus({ draft: false })).toBe('published');
    expect(getPublicationStatus({ publicationStatus: 'ready', draft: true })).toBe('ready');
  });
});

describe('内容审计', () => {
  test('待发布内容缺字段、未知分类和空图片 alt 会阻止构建', () => {
    const source = `---\ntitle: 正文\ndescription: 摘要\ndate: 2026-08-25T12:00:00+08:00\npublicationStatus: ready\ntags: [未知]\n---\n![](/missing.png)`;
    const document = {
      ...parseDocument(source, '/repo/src/content/blog/demo.md'),
      collection: 'blog',
    };
    const issues = auditDocuments([document], { taxonomies, assetExists: () => false });
    expect(issues.filter((item) => item.level === 'error').map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('自动更新时间'),
        expect.stringContaining('替代文本'),
        expect.stringContaining('图片文件不存在'),
        expect.stringContaining('未登记项'),
      ]),
    );
  });

  test('草稿问题只提醒，不阻止构建', () => {
    const source = `---\ntitle: CASDCV\npublicationStatus: draft\n---\ntest`;
    const document = {
      ...parseDocument(source, '/repo/src/content/blog/draft.md'),
      collection: 'blog',
    };
    const issues = auditDocuments([document], { taxonomies });
    expect(issues.some((item) => item.level === 'error')).toBe(false);
    expect(issues.some((item) => item.level === 'warning')).toBe(true);
  });
});

describe('篇幅估算', () => {
  test('统计中英文并至少返回一分钟', () => {
    expect(countWords('你好 Astro world')).toBe(4);
    expect(estimateReadingMinutes('短文')).toBe(1);
  });
});
