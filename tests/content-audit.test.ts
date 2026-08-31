import { describe, expect, test } from 'bun:test';
import {
  auditDocuments,
  countBodyLevelOneHeadings,
  parseDocument,
  publicationStatus,
} from '../scripts/lib/content-audit.mjs';
import {
  countWords,
  estimateReadingMinutes,
  getContentHealth,
  getPublicationStatus,
  matchesContentFilters,
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

  test('已发布正文不允许重复一级标题', () => {
    const source = `---\ntitle: 正文\ndescription: 摘要\ndate: 2026-08-25T12:00:00+08:00\nupdatedDate: 2026-08-25T12:00:00+08:00\npublicationStatus: published\n---\n# 正文\n\n## 章节`;
    const document = {
      ...parseDocument(source, '/repo/src/content/blog/published.md'),
      collection: 'blog',
    };
    const issues = auditDocuments([document], { taxonomies });

    expect(issues).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('正文请从二级标题开始'),
      }),
    );
  });

  test('一级标题检查忽略代码块中的 shell 注释', () => {
    expect(countBodyLevelOneHeadings('```sh\n# 这是注释\n```\n\n## 章节')).toBe(0);
    expect(countBodyLevelOneHeadings('标题\n===')).toBe(1);
    expect(countBodyLevelOneHeadings('<h1>标题</h1>')).toBe(1);
  });
});

describe('篇幅估算', () => {
  test('统计中英文并至少返回一分钟', () => {
    expect(countWords('你好 Astro world')).toBe(4);
    expect(estimateReadingMinutes('短文')).toBe(1);
  });
});

describe('后台内容筛选', () => {
  const article = {
    status: 'draft',
    type: '博客',
    text: '个人站 Astro 站点日志',
    health: 'issues',
  };

  test('组合状态、类型和中文搜索', () => {
    expect(matchesContentFilters(article, { status: 'draft', type: '博客', query: 'astro' })).toBe(
      true,
    );
    expect(matchesContentFilters(article, { status: 'published', type: '博客', query: '' })).toBe(
      false,
    );
    expect(matchesContentFilters(article, { status: 'all', type: '随记', query: '' })).toBe(false);
    expect(matchesContentFilters(article, { status: 'all', type: 'all', query: '站点日志' })).toBe(
      true,
    );
    expect(matchesContentFilters(article, { status: 'issues', type: 'all', query: '' })).toBe(true);
  });
});

describe('内容健康度', () => {
  test('项目案例给出可执行的完善建议', () => {
    expect(
      getContentHealth({
        collection: 'projects',
        id: 'demo',
        body: '项目正文',
        data: {
          title: '示例项目',
          description: '说明',
          date: '2026-08-26',
          updatedDate: '2026-08-26',
          publicationStatus: 'ready',
          links: [],
        },
      }),
    ).toEqual(expect.arrayContaining(['补充项目链接', '补充项目成果', '说明你的角色']));
  });

  test('完整文章健康度通过', () => {
    expect(
      getContentHealth({
        collection: 'blog',
        id: 'complete',
        body: '完整正文',
        data: {
          title: '完整文章',
          description: '摘要',
          date: '2026-08-26',
          updatedDate: '2026-08-26',
          publicationStatus: 'published',
          tags: ['Astro'],
        },
      }),
    ).toEqual([]);
  });
});
