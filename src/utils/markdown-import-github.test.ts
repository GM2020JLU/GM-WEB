import { describe, expect, test } from 'bun:test';
import { createGitHubMarkdownFile, MarkdownImportConflictError } from './markdown-import-github';

describe('Markdown GitHub 写入', () => {
  test('只在目标不存在时创建文件', async () => {
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const request = async (route: string, parameters: Record<string, unknown>) => {
      calls.push({ route, parameters });
      if (route.startsWith('GET')) throw Object.assign(new Error('Not found'), { status: 404 });
      return { data: { content: { path: parameters.path } } };
    };
    await createGitHubMarkdownFile(
      { token: 'test', path: 'src/content/blog/new.md', content: '内容' },
      request,
    );
    expect(calls.map((call) => call.route)).toEqual([
      'GET /repos/{owner}/{repo}/contents/{path}',
      'PUT /repos/{owner}/{repo}/contents/{path}',
    ]);
    expect(calls[1]?.parameters.branch).toBe('main');
    expect(calls[1]?.parameters.content).toBe(Buffer.from('内容').toString('base64'));
  });

  test('目标已存在时不发起 PUT', async () => {
    let calls = 0;
    const request = async () => {
      calls++;
      return { data: {} };
    };
    try {
      await createGitHubMarkdownFile(
        { token: 'test', path: 'src/content/blog/existing.md', content: '内容' },
        request,
      );
      throw new Error('预期导入冲突');
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownImportConflictError);
    }
    expect(calls).toBe(1);
  });

  test('并发创建冲突也转换为不覆盖错误', async () => {
    const request = async (route: string) => {
      if (route.startsWith('GET')) throw Object.assign(new Error('Not found'), { status: 404 });
      throw Object.assign(new Error('Validation failed'), { status: 422 });
    };
    try {
      await createGitHubMarkdownFile(
        { token: 'test', path: 'src/content/blog/race.md', content: '内容' },
        request,
      );
      throw new Error('预期导入冲突');
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownImportConflictError);
    }
  });
});
