import type { GoalRecord } from './goals';

export const MODEL_VERSION = 1;
export const MAX_RECORD_BYTES = 256 * 1024;
export const RECORD_PREFIXES = ['annual-goal:', 'objective:', 'kr:'] as const;
export const WIPE_KEY = 'meta:wipe';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const goalOutcomes = ['achieved', 'completed', 'cancelled'];
const krOutcomes = ['achieved', 'not-achieved', 'cancelled'];
const encoder = new TextEncoder();

type Fields = Record<string, unknown>;
type RecordKind = GoalRecord['kind'];
type Tombstone = { readonly deleted: true };
export type RecordInput = GoalRecord | Tombstone | Record<string, never>;

interface RecordVersion {
  readonly v: typeof MODEL_VERSION;
  readonly ver: string;
  readonly at: number;
}

export type StoredRecord = RecordVersion | (RecordVersion & (GoalRecord | Tombstone));
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
  if (kind === 'annual-goal' || kind === 'objective' || kind === 'kr') return kind;
  return undefined;
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
    typeof record.objectiveKey === 'string' &&
    kindForKey(record.objectiveKey) === 'objective' &&
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

function isGoalRecord(record: Fields, kind: RecordKind): record is Fields & GoalRecord {
  if (record.kind !== kind) return false;
  if (kind === 'annual-goal') return isLifecycleRecord(record, [], goalOutcomes);
  if (kind === 'objective') {
    return (
      isNonBlank(record.quarter) &&
      typeof record.annualGoalKey === 'string' &&
      kindForKey(record.annualGoalKey) === 'annual-goal' &&
      isLifecycleRecord(record, ['quarter', 'annualGoalKey'], goalOutcomes)
    );
  }
  return (
    isKrVersion(record, ['history']) &&
    Array.isArray(record.history) &&
    record.history.every(isKrRevision)
  );
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
  if (v !== MODEL_VERSION) return { ok: false, reason: 'unsupported-version' };
  if (
    !isUuid(ver) ||
    typeof at !== 'number' ||
    !Number.isSafeInteger(at) ||
    Number.isNaN(new Date(at).getTime())
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const version: RecordVersion = { v, ver, at };
  if (kind === undefined && hasOnlyFields(record, [])) return { ok: true, value: version };
  if (kind !== undefined) {
    if (record.deleted === true && hasOnlyFields(record, ['deleted'])) {
      return { ok: true, value: { ...version, deleted: true } };
    }
    if (isGoalRecord(record, kind)) return { ok: true, value: { ...version, ...record } };
  }
  return { ok: false, reason: 'invalid' };
}
