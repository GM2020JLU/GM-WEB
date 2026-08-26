import { describe, expect, test } from 'bun:test';
import { createImportedMarkdown, type MarkdownImportCollection } from './markdown-import';
import { parseStudioDocument, serializeStudioDocument } from './studio-content';

const definitions: Array<{
  collection: MarkdownImportCollection;
  creator?: string;
  description: string;
  extension: 'md' | 'mdx';
}> = [
  { collection: 'blog', description: '这是用于验证博客发布流程的完整摘要。', extension: 'md' },
  { collection: 'projects', description: '这是用于验证项目发布流程的完整摘要。', extension: 'mdx' },
  { collection: 'vibe', description: '', extension: 'md' },
  { collection: 'media', creator: '测试作者', description: '', extension: 'md' },
];

describe('Studio 各内容模块完整工作流', () => {
  for (const definition of definitions) {
    test(`${definition.collection} 完成导入、编辑和发布`, () => {
      const slug = `workflow-${definition.collection}`;
      const imported = createImportedMarkdown(
        {
          collection: definition.collection,
          filename: `${slug}.md`,
          source: `---\ntitle: ${definition.collection} 初稿\n---\n\n# 初始正文`,
          slug,
          title: `${definition.collection} 初稿`,
          description: definition.description,
          creator: definition.creator ?? '',
        },
        new Date('2026-08-26T00:00:00Z'),
      );
      expect(imported.path).toBe(
        `src/content/${definition.collection}/${slug}.${definition.extension}`,
      );

      const draft = parseStudioDocument(definition.collection, slug, imported.content);
      expect(draft.metadata.publicationStatus).toBe('draft');
      const edited = serializeStudioDocument(
        definition.collection,
        slug,
        { ...draft.metadata, title: `${definition.collection} 已编辑` },
        `${draft.body}\n\n编辑后的段落。`,
        'published',
      );
      const published = parseStudioDocument(definition.collection, slug, edited);
      expect(published.metadata.title).toBe(`${definition.collection} 已编辑`);
      expect(published.metadata.publicationStatus).toBe('published');
      expect(published.metadata.draft).toBe(false);
      expect(published.body).toContain('编辑后的段落');
    });
  }

  test('关于页完成编辑与发布', () => {
    const source = `---\ntitle: 关于我\ndescription: 这是用于验证关于页面发布流程的完整摘要。\ndate: '2026-08-26T10:00:00+08:00'\npublicationStatus: draft\ndraft: true\n---\n\n# 关于正文`;
    const document = parseStudioDocument('about', 'about', source);
    const published = serializeStudioDocument(
      'about',
      'about',
      { ...document.metadata, title: '更新后的关于我' },
      `${document.body}\n\n新增介绍。`,
      'published',
    );
    expect(published).toContain('publicationStatus: published');
    expect(published).toContain('新增介绍');
  });
});
