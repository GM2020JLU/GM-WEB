import { describe, expect, test } from 'bun:test';
import {
  defaultStudioMetadata,
  parseStudioDocument,
  serializeStudioDocument,
  studioContentPath,
  studioPublicUrl,
  isScheduledPublicationDue,
  validateStudioDocument,
  validateStudioTaxonomyReferences,
} from './studio-content';

describe('Studio 内容模型', () => {
  test('发布前拒绝未登记的分类、系列和标签', () => {
    expect(() =>
      validateStudioTaxonomyReferences(
        { categories: ['未登记'], tags: ['Astro'] },
        {
          categories: new Set(['站点日志']),
          series: new Set(['个人站重建']),
          tags: new Set(['Astro']),
        },
      ),
    ).toThrow('categories：未登记');
  });
  test('为每种内容生成受限路径', () => {
    expect(studioContentPath('blog', 'linux-notes')).toBe('src/content/blog/linux-notes.md');
    expect(studioContentPath('projects', 'board-bringup')).toBe(
      'src/content/projects/board-bringup.mdx',
    );
    expect(studioContentPath('about', 'ignored')).toBe('src/content/about.mdx');
    expect(studioContentPath('tags', 'Linux')).toBe('src/content/taxonomies/tags/Linux.yaml');
    expect(() => studioContentPath('blog', '../secret')).toThrow('网址别名');
  });

  test('解析与序列化 Markdown frontmatter 并同步发布状态', () => {
    const source = `---\ntitle: 测试文章\ndescription: 这是用于验证发布流程的完整文章摘要。\ndate: '2026-08-26T10:00:00+08:00'\nscheduledAt: '2026-08-27T10:00:00+08:00'\npublicationStatus: draft\ndraft: true\n---\n\n# 正文\n`;
    const parsed = parseStudioDocument('blog', 'test-post', source, 'abc');
    expect(parsed.metadata.title).toBe('测试文章');
    expect(parsed.body.trim()).toBe('# 正文');
    expect(parsed.sha).toBe('abc');

    const published = serializeStudioDocument(
      'blog',
      'test-post',
      parsed.metadata,
      parsed.body,
      'published',
    );
    expect(published).toContain('publicationStatus: published');
    expect(published).toContain('draft: false');
    expect(published).toContain('# 正文');
    expect(published).not.toContain('scheduledAt');
  });

  test('发布前校验摘要和日期，草稿允许逐步补充', () => {
    const metadata = { title: '半成品', publicationStatus: 'draft' };
    expect(() => validateStudioDocument('blog', 'draft-post', metadata, 'draft')).not.toThrow();
    expect(() => validateStudioDocument('blog', 'draft-post', metadata, 'published')).toThrow(
      '摘要',
    );
    expect(() =>
      serializeStudioDocument(
        'blog',
        'short-summary',
        {
          title: '摘要测试',
          description: 'xascasca',
          date: '2026-08-26T10:00:00+08:00',
        },
        '这是一段有效正文。',
        'published',
      ),
    ).toThrow('摘要过短');
  });

  test('发布超长随记时提醒改用博客模块', () => {
    expect(() =>
      serializeStudioDocument(
        'vibe',
        'too-long',
        { title: '超长随记', date: '2026-08-26T10:00:00+08:00' },
        '内容'.repeat(900),
        'published',
      ),
    ).toThrow('请改用“博客文章”模块');
  });

  test('拒绝拼错字段和不属于当前模块的字段并给出中文提示', () => {
    expect(() =>
      serializeStudioDocument(
        'vibe',
        'field-error',
        {
          title: '字段测试',
          date: '2026-08-26T10:00:00+08:00',
          description: '随记没有摘要字段',
        },
        '正文',
        'published',
      ),
    ).toThrow('随记不支持字段 “description（摘要）”');
    expect(() =>
      serializeStudioDocument(
        'media',
        'typo',
        { title: '字段测试', creatro: '拼错了' },
        '',
        'draft',
      ),
    ).toThrow('书影音不支持字段 “creatro”');
  });

  test('拒绝错误字段类型和无效选项', () => {
    expect(() =>
      serializeStudioDocument(
        'vibe',
        'bad-type',
        { title: '字段测试', tags: 'Linux' },
        '',
        'draft',
      ),
    ).toThrow('字段“tags”应为列表');
    expect(() =>
      serializeStudioDocument(
        'media',
        'bad-rating',
        { title: '字段测试', creator: '作者', type: 'book', status: 'planned', rating: 8 },
        '',
        'draft',
      ),
    ).toThrow('评分');
  });

  test('分类文件不会混入发布字段', () => {
    const source = serializeStudioDocument(
      'tags',
      'Astro',
      { title: 'Astro', description: '框架', publicationStatus: 'draft', draft: true },
      '',
    );
    expect(source).toBe('title: Astro\ndescription: 框架\n');
  });

  test('提供安全默认值和公开地址', () => {
    expect(defaultStudioMetadata('vibe')).toMatchObject({
      publicationStatus: 'draft',
      draft: true,
      type: 'text',
    });
    expect(studioPublicUrl('blog', 'hello')).toBe('/blog/hello');
    expect(studioPublicUrl('about', 'about')).toBe('/about');
    expect(studioPublicUrl('tags', 'Astro')).toBeUndefined();
  });

  test('只发布已经到期的待发布内容', () => {
    const now = new Date('2026-08-26T12:00:00+08:00');
    expect(
      isScheduledPublicationDue(
        { publicationStatus: 'ready', scheduledAt: '2026-08-26T11:45:00+08:00' },
        now,
      ),
    ).toBeTrue();
    expect(
      isScheduledPublicationDue(
        { publicationStatus: 'ready', scheduledAt: '2026-08-26T12:15:00+08:00' },
        now,
      ),
    ).toBeFalse();
    expect(
      isScheduledPublicationDue(
        { publicationStatus: 'draft', scheduledAt: '2026-08-26T11:45:00+08:00' },
        now,
      ),
    ).toBeFalse();
  });
});
