import { describe, expect, test } from 'bun:test';
import { findStudioAssetReferencePaths, studioAssetReference } from './studio-assets';

describe('Studio 素材引用', () => {
  test('保留 Keystatic 嵌套素材目录', () => {
    expect(studioAssetReference('src/assets/images/content/article/heroImage.png')).toBe(
      '@assets/images/content/article/heroImage.png',
    );
  });

  test('找出所有引用素材的内容并按路径排序', () => {
    expect(
      findStudioAssetReferencePaths(
        [
          { path: 'src/content/projects/demo.mdx', content: '无引用' },
          {
            path: 'src/content/vibe/note.md',
            content: 'images: [@assets/images/content/demo/cover.png]',
          },
          {
            path: 'src/content/blog/demo.md',
            content: 'heroImage: "@assets/images/content/demo/cover.png"',
          },
        ],
        'src/assets/images/content/demo/cover.png',
      ),
    ).toEqual(['src/content/blog/demo.md', 'src/content/vibe/note.md']);
  });

  test('识别相对路径、仓库根路径和 URL 后缀引用', () => {
    const asset = 'src/assets/images/content/demo/cover image.png';
    expect(
      findStudioAssetReferencePaths(
        [
          {
            path: 'src/content/blog/relative.md',
            content: '![封面](../../assets/images/content/demo/cover%20image.png?width=800)',
          },
          {
            path: 'src/content/projects/nested/root.mdx',
            content: '<Image src="/src/assets/images/content/demo/cover image.png" />',
          },
          {
            path: 'src/content/vibe/direct.md',
            content: 'image: src/assets/images/content/demo/cover image.png',
          },
          {
            path: 'src/content/blog/unrelated.md',
            content: '../../assets/images/content/demo/other.png',
          },
        ],
        asset,
      ),
    ).toEqual([
      'src/content/blog/relative.md',
      'src/content/projects/nested/root.mdx',
      'src/content/vibe/direct.md',
    ]);
  });

  test('拒绝素材目录外的路径', () => {
    expect(() => studioAssetReference('public/avatar.png')).toThrow('src/assets');
  });
});
