import { describe, expect, test } from 'bun:test';
import { findStudioTaxonomyReferencePaths } from './studio-asset-references';

describe('Studio 分类引用', () => {
  test('只阻止删除 frontmatter 中精确引用的分类项', () => {
    expect(
      findStudioTaxonomyReferencePaths(
        [
          {
            path: 'src/content/blog/one.md',
            content: '---\ntitle: One\ntags:\n  - Linux\n---\n\n正文里提到 Linux。',
          },
          {
            path: 'src/content/projects/two.mdx',
            content: '---\ntitle: Two\ntags: [Linux Kernel]\n---\n',
          },
          {
            path: 'src/content/vibe/three.md',
            content: '---\ntitle: Three\ncategories: [Linux]\n---\n',
          },
          {
            path: 'src/content/taxonomies/tags/Linux.yaml',
            content: 'title: Linux',
          },
        ],
        'tags',
        'Linux',
      ),
    ).toEqual(['src/content/blog/one.md']);
  });
});
