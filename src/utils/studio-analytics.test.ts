import { describe, expect, test } from 'bun:test';
import { getStudioAnalytics } from './studio-analytics';

describe('studio analytics', () => {
  test('summarizes status, health and words by module', () => {
    const result = getStudioAnalytics([
      {
        collection: 'blog',
        id: 'one',
        data: {
          title: '文章',
          description: '摘要',
          date: '2026-08-01',
          updatedDate: '2026-08-02',
          publicationStatus: 'published',
          categories: ['技术'],
        },
        body: '你好 world',
      },
      {
        collection: 'blog',
        id: 'two',
        data: { title: '草稿', draft: true },
        body: '草稿',
      },
      { collection: 'projects', id: 'one', data: { title: '项目' }, body: '' },
    ]);

    expect(result.total).toBe(3);
    expect(result.published).toBe(2);
    expect(result.draft).toBe(1);
    expect(result.issues).toBe(2);
    expect(result.words).toBe(5);
    expect(result.modules.find((module) => module.collection === 'blog')).toMatchObject({
      total: 2,
      published: 1,
      draft: 1,
      words: 5,
    });
  });
});
