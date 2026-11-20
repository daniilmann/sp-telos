import type { GoalRecord } from './goals';

export const MODEL_VERSION = 2;
export const MAX_RECORD_BYTES = 256 * 1024;
export const RECORD_PREFIXES = [
  'annual-goal:',
  'objective:',
  'kr:',
  'initiative:',
  'task-meta:',
] as const;
export const WIPE_KEY = 'meta:wipe';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const goalOutcomes = ['achieved', 'completed', 'cancelled'];
const krOutcomes = ['achieved', 'not-achieved', 'cancelled'];
const encoder = new TextEncoder();

type Fields = Record<string, unknown>;
type GoalKind = GoalRecord['kind'];
type RecordKind = GoalKind | Initiative['kind'] | TaskMeta['kind'];
type Tombstone = { readonly deleted: true };

type InitiativeSchedule =
  | { readonly initiativeType: 'one-off'; readonly cadence?: never }
  | { readonly initiativeType: 'regular'; readonly cadence: string };

export type Initiative = {
  readonly kind: 'initiative';
  readonly projectKey: string;
  readonly krKey: string;
} & InitiativeSchedule;

export interface TaskMeta {
  readonly kind: 'task-meta';
  readonly taskKey: string;
  readonly initiativeKey?: string;
  readonly sphereTagKey?: string;
  readonly directKrKeys?: readonly string[];
}

export type RecordInput = GoalRecord | Initiative | TaskMeta | Tombstone | Record<string, never>;

type ReadVersion = 1 | typeof MODEL_VERSION;

interface RecordVersion<Version extends ReadVersion = ReadVersion> {
  readonly v: Version;
  readonly ver: string;
  readonly at: number;
}

export type StoredGoalRecord = RecordVersion | (RecordVersion & (GoalRecord | Tombstone));
export type StoredRecord =
  | StoredGoalRecord
  | (RecordVersion<typeof MODEL_VERSION> & (Initiative | TaskMeta));
type DecodeFailure = 'invalid' | 'size' | 'unsupported-version';

type DecodeResult =
  | { readonly ok: true; readonly value: StoredRecord }
  | { readonly ok: false; readonly reason: DecodeFailure };

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

export function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isModelVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function recordByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => {
    if (!isObject(field)) return field;
    return Object.fromEntries(
      Object.keys(field)
        .sort((first, second) => (first < second ? -1 : Number(first > second)))
        .map((key) => [key, field[key]]),
    );
  });
}

function kindForKey(key: string): RecordKind | undefined {
  const [kind, id, extra] = key.split(':');
  if (extra !== undefined || !isUuid(id)) return undefined;
  switch (kind) {
    case 'annual-goal':
    case 'objective':
    case 'kr':
    case 'initiative':
    case 'task-meta':
      return kind;
    default:
      return undefined;
  }
}

export function isRecordKeyOfKind(value: unknown, kind: RecordKind): value is string {
  return typeof value === 'string' && kindForKey(value) === kind;
}

export function isBaseKey(value: unknown, kind: 'project' | 'task' | 'tag'): value is string {
  const prefix = `${kind}:`;
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length;
}

function hasOnlyFields(record: Fields, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isLifecycleRecord(
  record: Fields,
  fields: readonly string[],
  outcomes: readonly string[],
): boolean {
  const common = ['kind', 'statement', 'status', ...fields];
  if (!isNonBlank(record.statement)) return false;
  if (record.status === 'active') return hasOnlyFields(record, common);
  return (
    record.status === 'closed' &&
    typeof record.outcome === 'string' &&
    outcomes.includes(record.outcome) &&
    isNonBlank(record.closureReason) &&
    hasOnlyFields(record, [...common, 'outcome', 'closureReason'])
  );
}

function isKrVersion(record: Fields, fields: readonly string[]): boolean {
  return (
    record.kind === 'kr' &&
    isNonBlank(record.baseline) &&
    isNonBlank(record.dataSource) &&
    isNonBlank(record.target) &&
    isRecordKeyOfKind(record.objectiveKey, 'objective') &&
    isLifecycleRecord(
      record,
      ['baseline', 'dataSource', 'target', 'objectiveKey', ...fields],
      krOutcomes,
    )
  );
}

function isKrRevision(value: unknown): boolean {
  return (
    isObject(value) && isNonBlank(value.revisionReason) && isKrVersion(value, ['revisionReason'])
  );
}

function isGoalRecord(
  record: Fields,
  kind: GoalKind,
  version: ReadVersion,
): record is Fields & GoalRecord {
  if (record.kind !== kind) return false;
  if (kind === 'kr') {
    return (
      isKrVersion(record, ['history']) &&
      Array.isArray(record.history) &&
      record.history.every(isKrRevision)
    );
  }

  const sphereFields = version === MODEL_VERSION ? ['sphereTagKey'] : [];
  if ('sphereTagKey' in record && !isBaseKey(record.sphereTagKey, 'tag')) return false;
  if (kind === 'annual-goal') return isLifecycleRecord(record, sphereFields, goalOutcomes);
  return (
    isNonBlank(record.quarter) &&
    isRecordKeyOfKind(record.annualGoalKey, 'annual-goal') &&
    isLifecycleRecord(record, ['quarter', 'annualGoalKey', ...sphereFields], goalOutcomes)
  );
}

function isInitiative(record: Fields): record is Fields & Initiative {
  if (
    record.kind !== 'initiative' ||
    !isBaseKey(record.projectKey, 'project') ||
    !isRecordKeyOfKind(record.krKey, 'kr')
  )
    return false;

  const fields = ['kind', 'projectKey', 'krKey', 'initiativeType'];
  if (record.initiativeType === 'one-off') return hasOnlyFields(record, fields);
  return (
    record.initiativeType === 'regular' &&
    isNonBlank(record.cadence) &&
    hasOnlyFields(record, [...fields, 'cadence'])
  );
}

function isKrKeySet(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((key) => isRecordKeyOfKind(key, 'kr')) &&
    new Set(value).size === value.length
  );
}

function isTaskMeta(record: Fields): record is Fields & TaskMeta {
  return (
    record.kind === 'task-meta' &&
    isBaseKey(record.taskKey, 'task') &&
    (!('initiativeKey' in record) || isRecordKeyOfKind(record.initiativeKey, 'initiative')) &&
    (!('sphereTagKey' in record) || isBaseKey(record.sphereTagKey, 'tag')) &&
    (!('directKrKeys' in record) || isKrKeySet(record.directKrKeys)) &&
    hasOnlyFields(record, ['kind', 'taskKey', 'initiativeKey', 'sphereTagKey', 'directKrKeys'])
  );
}

function decodeBody(
  kind: RecordKind | undefined,
  version: RecordVersion,
  record: Fields,
): StoredRecord | undefined {
  if (kind === undefined) return hasOnlyFields(record, []) ? version : undefined;
  if (version.v === 1 && (kind === 'initiative' || kind === 'task-meta')) return undefined;
  if (record.deleted === true && hasOnlyFields(record, ['deleted'])) {
    return { ...version, deleted: true };
  }
  if (kind === 'initiative' || kind === 'task-meta') {
    const valid = kind === 'initiative' ? isInitiative(record) : isTaskMeta(record);
    return valid ? { ...version, v: MODEL_VERSION, ...record } : undefined;
  }
  return isGoalRecord(record, kind, version.v) ? { ...version, ...record } : undefined;
}

type VersionFields = { readonly v?: unknown; readonly ver?: unknown; readonly at?: unknown };
// Distribute the omission so it preserves the active/closed variants of a record.
type RecordFields<Value> = Value extends object ? Omit<Value, keyof VersionFields> : never;

export function splitRecord<Value extends object>({
  v,
  ver,
  at,
  ...record
}: Value & VersionFields) {
  return { v, ver, at, record: record as RecordFields<Value> };
}

export function decodeRecord(key: string, value: string): DecodeResult {
  if (typeof key !== 'string' || typeof value !== 'string') return { ok: false, reason: 'invalid' };
  const kind = kindForKey(key);
  if (kind === undefined && key !== WIPE_KEY) return { ok: false, reason: 'invalid' };
  if (recordByteLength(value) > MAX_RECORD_BYTES) return { ok: false, reason: 'size' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isObject(parsed)) return { ok: false, reason: 'invalid' };
  const { v, ver, at, record } = splitRecord(parsed);
  if (!isModelVersion(v)) return { ok: false, reason: 'invalid' };
  if (v !== 1 && v !== MODEL_VERSION) return { ok: false, reason: 'unsupported-version' };
  if (
    !isUuid(ver) ||
    typeof at !== 'number' ||
    !Number.isSafeInteger(at) ||
    Number.isNaN(new Date(at).getTime())
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const decoded = decodeBody(kind, { v, ver, at }, record);
  return decoded ? { ok: true, value: decoded } : { ok: false, reason: 'invalid' };
}
