import { createHash } from 'node:crypto';

export type StudioBackupRecord = {
  content: string;
  date: string;
  deleted?: boolean;
  encoding: 'base64' | 'utf8';
  kind?: 'history' | 'snapshot' | 'tombstone';
  message: string;
  path: string;
  sha: string;
  version?: 1;
};

function digest(value: string) {
  return createHash('sha1').update(value).digest('hex');
}

function canonicalPayload(record: Omit<StudioBackupRecord, 'sha'>) {
  return [
    'studio-backup-v1',
    record.kind,
    record.path,
    record.date,
    record.encoding,
    record.deleted ? 'deleted' : 'present',
    record.message,
    record.content,
  ].join('\0');
}

export function createStudioBackupRecord(
  input: Omit<StudioBackupRecord, 'sha' | 'version'> & {
    kind: NonNullable<StudioBackupRecord['kind']>;
  },
): StudioBackupRecord {
  const value = { ...input, version: 1 as const };
  return { ...value, sha: digest(canonicalPayload(value)) };
}

function legacyHashes(record: StudioBackupRecord) {
  if (record.deleted) return [digest(`offsite-delete\0${record.path}\0${record.date}`)];
  return [
    digest(`${record.path}\0${record.date}\0${record.encoding}\0${record.content}`),
    digest(`offsite\0${record.path}\0${record.date}\0${record.encoding}\0${record.content}`),
  ];
}

function validBase64(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

export function validateStudioBackupRecord(value: unknown, filename?: string) {
  if (!value || typeof value !== 'object') throw new Error('备份记录不是 JSON 对象。');
  const record = value as StudioBackupRecord;
  if (
    typeof record.content !== 'string' ||
    typeof record.date !== 'string' ||
    !Number.isFinite(Date.parse(record.date)) ||
    !['utf8', 'base64'].includes(record.encoding) ||
    typeof record.message !== 'string' ||
    typeof record.path !== 'string' ||
    !record.path ||
    typeof record.sha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(record.sha)
  ) {
    throw new Error('备份记录字段不合法。');
  }
  if (record.encoding === 'base64' && !validBase64(record.content)) {
    throw new Error('备份记录的 base64 内容已损坏。');
  }
  if (record.deleted && record.content !== '') throw new Error('删除标记不应包含文件内容。');
  if (filename && filename !== `${record.sha}.json`) {
    throw new Error(`备份文件名与记录 SHA 不一致：${filename}`);
  }
  let expected: string[];
  if (record.version === 1) {
    if (!record.kind || !['history', 'snapshot', 'tombstone'].includes(record.kind)) {
      throw new Error('备份记录类型不合法。');
    }
    if ((record.kind === 'tombstone') !== Boolean(record.deleted)) {
      throw new Error('备份记录类型与删除状态不一致。');
    }
    expected = [digest(canonicalPayload(record))];
  } else {
    expected = legacyHashes(record);
  }
  if (!expected.includes(record.sha)) throw new Error(`备份内容校验失败：${record.sha}`);
  return record;
}

export function parseStudioBackupRecord(source: string | Buffer, filename?: string) {
  let value: unknown;
  try {
    value = JSON.parse(String(source));
  } catch {
    throw new Error(`备份 JSON 已损坏${filename ? `：${filename}` : ''}。`);
  }
  return validateStudioBackupRecord(value, filename);
}
