export interface StudioAssetSourceFile {
  content: string;
  path: string;
}

export function studioAssetReference(path: string) {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized.startsWith('src/assets/')) {
    throw new Error('素材路径必须位于 src/assets。');
  }
  return `@assets/${normalized.slice('src/assets/'.length)}`;
}

function normalizedRepositoryPath(path: string) {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function relativeRepositoryPath(sourcePath: string, targetPath: string) {
  const source = normalizedRepositoryPath(sourcePath).split('/');
  const target = normalizedRepositoryPath(targetPath).split('/');
  source.pop();
  let shared = 0;
  while (shared < source.length && shared < target.length && source[shared] === target[shared]) {
    shared++;
  }
  return [...source.slice(shared).map(() => '..'), ...target.slice(shared)].join('/');
}

function includesReference(content: string, reference: string) {
  let offset = content.indexOf(reference);
  while (offset >= 0) {
    const next = content[offset + reference.length];
    if (!next || /[\s?#'"`)\]}>.,;]/u.test(next)) return true;
    offset = content.indexOf(reference, offset + 1);
  }
  return false;
}

export function findStudioAssetReferencePaths(files: StudioAssetSourceFile[], assetPath: string) {
  const normalizedAssetPath = normalizedRepositoryPath(assetPath);
  const reference = studioAssetReference(normalizedAssetPath);
  return files
    .filter((file) => {
      const relative = relativeRepositoryPath(file.path, normalizedAssetPath);
      const candidates = new Set([
        reference,
        normalizedAssetPath,
        `/${normalizedAssetPath}`,
        relative,
        encodeURI(reference),
        encodeURI(relative),
      ]);
      const content = file.content.replaceAll('\\', '/');
      return [...candidates].some((candidate) => includesReference(content, candidate));
    })
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}
