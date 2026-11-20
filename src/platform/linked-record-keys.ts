import { isBaseKey, type StoredRecord } from '../core/records';

// UUIDv5 of the repository URL in the standard URL namespace.
const namespace = new Uint8Array([
  0x66, 0x77, 0xf4, 0xa3, 0xa4, 0x38, 0x54, 0xc4, 0x9e, 0x72, 0xa4, 0xcf, 0x18, 0xf8, 0x3b, 0x4d,
]);
const encoder = new TextEncoder();

export async function linkedRecordKey(source: string): Promise<string> {
  const kind = isBaseKey(source, 'project') ? 'initiative' : 'task-meta';
  if (kind === 'task-meta' && !isBaseKey(source, 'task'))
    throw new Error('Некорректная ссылка на проект или задачу.');

  const name = encoder.encode(source);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const digest = await crypto.subtle.digest('SHA-1', input);
  const uuid = new DataView(digest, 0, 16);
  uuid.setUint8(6, (uuid.getUint8(6) & 0x0f) | 0x50);
  uuid.setUint8(8, (uuid.getUint8(8) & 0x3f) | 0x80);
  const hex = Array.from(new Uint8Array(digest, 0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${kind}:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function matchesLinkedRecord(
  key: string,
  source: string,
  expectedSource: string = source,
): Promise<boolean> {
  if (source !== expectedSource) return false;
  try {
    return (await linkedRecordKey(source)) === key;
  } catch {
    return false;
  }
}

export function linkedRecordSource(record?: StoredRecord): string | undefined {
  if (!record || !('kind' in record)) return undefined;
  if (record.kind === 'initiative') return record.projectKey;
  if (record.kind === 'task-meta') return record.taskKey;
  return undefined;
}
