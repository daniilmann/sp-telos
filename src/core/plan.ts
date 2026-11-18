import { reviseKr } from './goals';
import {
  canonicalJson,
  decodeRecord,
  isModelVersion,
  isObject,
  isUuid,
  MAX_RECORD_BYTES,
  MODEL_VERSION,
  recordByteLength,
  splitRecord,
  type RecordInput,
  type StoredRecord,
} from './records';

export { MODEL_VERSION };

export interface PlanState {
  readonly entries: Readonly<Record<string, string>>;
}

type PlanOrigin = 'manual' | 'kr-revision';

interface PlanWrite {
  readonly key: string;
  readonly base: string;
  readonly value: string;
}

export interface Plan {
  readonly v: number;
  readonly origin: PlanOrigin;
  readonly writes: readonly PlanWrite[];
}

interface PlanInput {
  readonly key: string;
  readonly base: string;
  readonly record: RecordInput;
}

interface PlanDependencies {
  readonly at: number;
  readonly newId: () => string;
}

export const EMPTY_STATE: PlanState = { entries: {} };

export function buildPlan(
  origin: PlanOrigin,
  inputs: readonly PlanInput[],
  { at, newId }: PlanDependencies,
): Plan {
  return {
    v: MODEL_VERSION,
    origin,
    writes: inputs.map(({ key, base, record }) => ({
      key,
      base,
      value: canonicalJson({ ...record, v: MODEL_VERSION, ver: newId(), at }),
    })),
  };
}

function isPlanWrite(write: unknown): write is PlanWrite {
  return (
    isObject(write) &&
    Object.keys(write).length === 3 &&
    typeof write.key === 'string' &&
    (write.base === 'absent' || isUuid(write.base)) &&
    typeof write.value === 'string'
  );
}

export function isPlan(plan: unknown): plan is Plan {
  if (
    !isObject(plan) ||
    Object.keys(plan).length !== 3 ||
    !isModelVersion(plan.v) ||
    (plan.origin !== 'manual' && plan.origin !== 'kr-revision') ||
    !Array.isArray(plan.writes)
  ) {
    return false;
  }
  for (const write of plan.writes) {
    if (!isPlanWrite(write)) return false;
  }
  return true;
}

type Rejection = 'stale' | 'invalid' | 'size' | 'history' | 'unsupported-version';

type Classification =
  | { readonly ok: true; readonly writes: readonly PlanWrite[] }
  | { readonly ok: false; readonly reason: Rejection };

function asKr(record?: StoredRecord) {
  return record && 'kind' in record && record.kind === 'kr' ? record : undefined;
}

function preservesHistory(
  origin: PlanOrigin,
  target: StoredRecord,
  current?: StoredRecord,
): boolean {
  const targetKr = asKr(target);
  const currentKr = asKr(current);
  if (origin === 'manual') {
    return (
      targetKr === undefined ||
      canonicalJson(targetKr.history) === canonicalJson(currentKr?.history ?? [])
    );
  }

  const revision = targetKr?.history[targetKr.history.length - 1];
  if (!currentKr || !targetKr || !revision) return false;
  const { record: currentBody } = splitRecord(currentKr);
  const { record: targetBody } = splitRecord(targetKr);
  const expected = reviseKr(currentBody, targetBody, revision.revisionReason);
  return expected.ok && canonicalJson(expected.value) === canonicalJson(targetBody);
}

function classifyWrite(
  state: PlanState,
  origin: PlanOrigin,
  write: PlanWrite,
  target: StoredRecord,
): 'write' | 'replay' | Rejection {
  if (write.base === target.ver) return 'invalid';

  const historyLength = asKr(target)?.history.length ?? 0;
  if (origin === 'kr-revision' && (write.base === 'absent' || historyLength === 0)) {
    return 'history';
  }
  if (write.base === 'absent' && historyLength > 0) return 'history';

  if (!Object.prototype.hasOwnProperty.call(state.entries, write.key)) {
    return write.base === 'absent' ? 'write' : 'stale';
  }

  const raw = state.entries[write.key];
  if (raw === undefined) return 'invalid';
  const current = decodeRecord(write.key, raw);
  if (!current.ok) return current.reason;
  if (current.value.ver === target.ver) return raw === write.value ? 'replay' : 'invalid';

  if (current.value.ver !== write.base || ('deleted' in current.value && !('deleted' in target))) {
    return 'stale';
  }

  const currentHistory = asKr(current.value)?.history;
  if (currentHistory?.length && recordByteLength(raw) === MAX_RECORD_BYTES) return 'history';
  return preservesHistory(origin, target, current.value) ? 'write' : 'history';
}

export function classifyPlan(state: PlanState, plan: Plan): Classification {
  if (!isPlan(plan)) return { ok: false, reason: 'invalid' };
  if (plan.v !== MODEL_VERSION) return { ok: false, reason: 'unsupported-version' };

  const keys = new Set<string>();
  const versions = new Set<string>();
  const writes: PlanWrite[] = [];
  for (const write of plan.writes) {
    if (keys.has(write.key)) return { ok: false, reason: 'invalid' };
    keys.add(write.key);

    const target = decodeRecord(write.key, write.value);
    if (!target.ok) return target;
    if (write.value !== canonicalJson(target.value)) return { ok: false, reason: 'invalid' };
    if (versions.has(target.value.ver)) return { ok: false, reason: 'invalid' };
    versions.add(target.value.ver);

    const classified = classifyWrite(state, plan.origin, write, target.value);
    if (classified === 'write') writes.push(write);
    else if (classified !== 'replay') return { ok: false, reason: classified };
  }
  return { ok: true, writes };
}

export function applyPlan(state: PlanState, plan: Plan): PlanState {
  const classified = classifyPlan(state, plan);
  if (!classified.ok || classified.writes.length === 0) return state;

  const entries = { ...state.entries };
  for (const { key, value } of classified.writes) entries[key] = value;
  return { entries };
}
