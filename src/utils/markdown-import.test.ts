import { describe, expect, test } from 'bun:test';
import { createImportedMarkdown, parseMarkdownImport } from './markdown-import';
import { markdownImportRequestSchema } from './markdown-import-schema';

describe('Markdown 导入', () => {
  test('复用 Markdown AST 和 YAML 解析 frontmatter', () => {
    const preview = parseMarkdownImport(
      'hello-world.md',
      `---\ntitle: 测试文章\ndescription: 这是摘要\ntags: [Astro, Linux]\n---\n\n# 正文\n\n内容中的 --- 不会被当成 frontmatter。`,
    );
    expect(preview.title).toBe('测试文章');
    expect(preview.slug).toBe('hello-world');
    expect(preview.body).toContain('内容中的 ---');
    expect(preview.data.tags).toEqual(['Astro', 'Linux']);
  });

  test('无 frontmatter 时从标题和首段生成预览', () => {
    const preview = parseMarkdownImport('first-note.md', '# 第一篇\n\n这是第一段摘要。');
    expect(preview.title).toBe('第一篇');
    expect(preview.description).toBe('这是第一段摘要。');
    expect(preview.warnings).toContain('未发现 YAML frontmatter，已尝试从正文提取标题和摘要。');
  });

  test('强制为草稿并不保留来源的已发布状态', () => {
    const result = createImportedMarkdown(
      {
        collection: 'blog',
        filename: 'published.md',
        source:
          '---\ntitle: 原文\ndescription: 原摘要\npublicationStatus: published\ndraft: false\n---\n正文',
        slug: 'safe-draft',
        title: '安全草稿',
        description: '导入摘要',
        creator: '',
      },
      new Date('2026-08-26T00:00:00Z'),
    );
    expect(result.path).toBe('src/content/blog/safe-draft.md');
    expect(result.content).toContain('publicationStatus: draft');
    expect(result.content).toContain('draft: true');
    expect(result.content).not.toContain('publicationStatus: published');
    expect(result.content).toContain('updatedDate: 2026-08-26T08:00:00+08:00');
  });

  test('拒绝非 Markdown、非法 slug 和 YAML 别名', () => {
    expect(() => parseMarkdownImport('post.mdx', '# MDX')).toThrow('目前只支持 .md');
    expect(() =>
      markdownImportRequestSchema.parse({
        collection: 'blog',
        filename: 'post.md',
        source: '# post',
        slug: '../escape',
        title: 'Post',
        description: '',
        creator: '',
      }),
    ).toThrow('网址别名只能');
    expect(() => parseMarkdownImport('post.md', '---\na: &a [1]\nb: *a\n---\nbody')).toThrow();
    expect(() => parseMarkdownImport('post.md', '# post\n\n<script>alert(1)</script>')).toThrow(
      '不能包含原始 HTML',
    );
  });
});
