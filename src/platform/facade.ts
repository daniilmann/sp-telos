import { sameDraft, type Draft, type DraftStore } from './draft-store';
import type { SaveState } from '@super-productivity/plugin-api';
import type { ApplyOptions } from '../app/commands';
import type { Plan, PlanState } from '../core/plan';
import {
  decodeRecord,
  isModelVersion,
  isObject,
  isUuid,
  KR_VALUE_PREFIX,
  MODEL_VERSION,
  RECORD_PREFIXES,
  WIPE_KEY,
} from '../core/records';
import { readBaseReferences } from './base-references';
import { linkedRecordKey, linkedRecordSource, matchesLinkedRecord } from './linked-record-keys';

export interface Facade<ApplyResult = PlanState> {
  read(): Promise<PlanState>;
  apply(plan: Plan): Promise<ApplyResult>;
}

export interface ReadSnapshot extends PlanState {
  readonly readOnlyReason?: string;
}

export interface PlanHandoff {
  readonly transferred: number;
  readonly total: number;
  readonly writes: Plan['writes'];
}

export type HandoffOptions = ApplyOptions;
export type HandoffObserver = ((message: string) => void) & HandoffOptions;

export function now(): number {
  return Date.now();
}

export function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function missingMethodsReason(methods: readonly string[]): string | undefined {
  if (methods.length === 0) return undefined;
  return `Только чтение. Обновите основу: отсутствуют методы ${methods.join(', ')}.`;
}

const READ_METHODS = ['listSyncedDataKeys', 'loadSyncedData'] as const;

export function missingReadMethods(): string[] {
  return READ_METHODS.filter((method) => typeof PluginAPI[method] !== 'function');
}

function isRecordKey(key: string): boolean {
  return (
    key === WIPE_KEY ||
    RECORD_PREFIXES.some((prefix) => key.startsWith(prefix) && isUuid(key.slice(prefix.length)))
  );
}

const unknownVersion = 'Только чтение. Обновите плагин: обнаружена неизвестная версия схемы.';
const enumerationFailure = 'Только чтение. Не удалось перечислить ключи для проверки схемы.';
export const enumerationTimeout = `${enumerationFailure} Истекло время ожидания ответа.`;

function invalidRecordReason(key: string, raw: string): string | undefined {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    // A damaged JSON value cannot establish its version.
  }
  if (!isObject(record) || !isModelVersion(record.v))
    return `Только чтение. Не удалось проверить версию схемы записи ${key}.`;
  const legacyKey =
    !key.startsWith('initiative:') &&
    !key.startsWith('task-meta:') &&
    !key.startsWith(KR_VALUE_PREFIX);
  if (record.v !== MODEL_VERSION && !(record.v === 1 && legacyKey)) return unknownVersion;
  return key === WIPE_KEY ? 'Только чтение. Некорректная схема маркера meta:wipe.' : undefined;
}

type RecordRead =
  | { readonly status: 'read'; readonly value: string; readonly source: string | undefined }
  | { readonly status: 'absent' }
  | { readonly status: 'unread'; readonly reason?: string | undefined };

function inspectRecord(key: string, raw: string): RecordRead {
  const decoded = decodeRecord(key, raw);
  return decoded.ok
    ? { status: 'read', value: raw, source: linkedRecordSource(decoded.value) }
    : {
        status: 'unread',
        reason:
          decoded.reason === 'unsupported-version' ? unknownVersion : invalidRecordReason(key, raw),
      };
}

function snapshotFromReads(
  reads: readonly (readonly [string, RecordRead])[],
  readOnlyReason?: string,
  previouslyUnread?: readonly string[],
): ReadSnapshot {
  const entries: [string, string][] = [];
  const unread = new Set(previouslyUnread);
  for (const [key, record] of reads) {
    if (record.status === 'read') entries.push([key, record.value]);
    if (record.status === 'unread') {
      unread.add(key);
      readOnlyReason ??= record.reason;
    }
  }
  return {
    entries: Object.fromEntries(entries),
    ...(unread.size > 0 && { unreadKeys: [...unread] }),
    ...(readOnlyReason && { readOnlyReason }),
  };
}

// Structural inspection for callers with an in-memory snapshot.
export function inspectRecords({ entries, unreadKeys }: PlanState): ReadSnapshot {
  return snapshotFromReads(
    Object.entries(entries).map(([key, raw]) => [key, inspectRecord(key, raw)]),
    undefined,
    unreadKeys,
  );
}

async function readRecord(key: string, listed: boolean): Promise<RecordRead> {
  const reason = `Только чтение. Не удалось прочитать запись ${key}.`;
  let raw: string | null;
  try {
    raw = await PluginAPI.loadSyncedData(key);
  } catch {
    return { status: 'unread', reason };
  }
  if (raw === null) return listed ? { status: 'unread', reason } : { status: 'absent' };

  const record = inspectRecord(key, raw);
  if (
    record.status === 'read' &&
    record.source !== undefined &&
    !(await matchesLinkedRecord(key, record.source))
  ) {
    return { status: 'unread' };
  }
  return record;
}

export async function readRecords(additionalKeys: readonly string[] = []): Promise<ReadSnapshot> {
  const missing = missingReadMethods();
  const readOnlyReason = missingMethodsReason(missing);
  if (readOnlyReason && missing.includes('loadSyncedData')) return { entries: {}, readOnlyReason };

  const collections = missing.includes('listSyncedDataKeys')
    ? []
    : await Promise.allSettled(
        RECORD_PREFIXES.map(async (prefix) => PluginAPI.listSyncedDataKeys(prefix)),
      );
  const listed = new Set<string>();
  const failures: unknown[] = [];
  for (const collection of collections) {
    if (collection.status === 'fulfilled') {
      for (const key of collection.value) listed.add(key);
    } else {
      failures.push(collection.reason);
    }
  }
  // Pending writes may be readable by key before they appear in the collection listing.
  const keys = [...new Set([...listed, WIPE_KEY, ...additionalKeys.filter(isRecordKey)])];
  const reads = await Promise.all(
    keys.map(async (key) => [key, await readRecord(key, listed.has(key))] as const),
  );
  const snapshot = snapshotFromReads(reads, readOnlyReason);
  if (snapshot.readOnlyReason || failures.length === 0) return snapshot;
  const timedOut = failures.every(
    (error) => error instanceof Error && error.message === 'API call timeout',
  );
  return { ...snapshot, readOnlyReason: timedOut ? enumerationTimeout : enumerationFailure };
}

export function createHostFacade() {
  return {
    read: readRecords,
    readBaseReferences,
    linkedRecordKey,
    readSaveState(keys: string[]): Promise<SaveState> {
      return PluginAPI.getSyncedDataSaveState(keys);
    },
  };
}

export interface EditorFacade extends Facade<PlanHandoff> {
  apply(plan: Plan, onIncomplete?: HandoffObserver): Promise<PlanHandoff>;
  read(keys?: readonly string[]): Promise<ReadSnapshot>;
  readBaseReferences?: typeof readBaseReferences;
  linkedRecordKey?: typeof linkedRecordKey;
  readSaveState(keys: string[]): Promise<SaveState>;
}

export async function handoffGoalPlan(
  facade: EditorFacade,
  plan: Plan,
  { key, value }: Plan['writes'][number],
  onIncomplete: (message: string) => void,
  options: HandoffOptions,
) {
  try {
    await facade.apply(plan, Object.assign(onIncomplete, options));
    return { applied: true };
  } catch (error) {
    const refreshed = await facade.read([key]).catch(() => undefined);
    return {
      applied: refreshed?.entries[key] === value,
      message: error instanceof Error ? error.message : 'Состояние неизвестно',
      refreshed,
    };
  }
}

export async function handleDraftWipe(
  drafts: DraftStore,
  ver: string,
  discard: boolean,
  isCurrent: () => boolean,
) {
  const listed = await drafts.list();
  if (!isCurrent()) return undefined;
  if (listed.failed) return false;
  if (discard) {
    for (const key of listed.keys) drafts.remove(key);
  }
  drafts.writeWipeVersion(ver);
  return (await drafts.flush()).ok;
}

export async function removeConfirmedDraft(
  drafts: DraftStore,
  key: string,
  expected: Draft,
  applicable: () => boolean,
): Promise<'removed' | 'skipped' | 'write-failed' | 'remove-failed' | undefined> {
  const observed = await drafts.read(key);
  if (!applicable() || (!observed.confirmedRemoval && !sameDraft(observed.value, expected)))
    return undefined;
  // Drain the pending write before removing. A later poll can revoke this proof while waiting.
  const settled = await drafts.flush();
  if (!applicable()) return undefined;
  if (observed.confirmedRemoval?.state === 'skipped') return 'skipped';
  if (!settled.ok) return observed.confirmedRemoval ? 'remove-failed' : 'write-failed';
  const latest = await drafts.read(key);
  if (!applicable() || latest.failed) return undefined;
  if (observed.confirmedRemoval)
    return observed.confirmedRemoval.state === 'removed' && latest.value === undefined
      ? 'removed'
      : undefined;
  if (!sameDraft(latest.value, expected)) return undefined;
  const removal = drafts.removeConfirmed(key, expected, applicable);
  if (!removal) return undefined;
  const after = await drafts.flush();
  if (removal.state === 'skipped') return 'skipped';
  if (!after.ok) return 'remove-failed';
  return removal.state === 'removed' ? 'removed' : undefined;
}
