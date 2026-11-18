import { sameDraft, type Draft, type DraftStore } from './draft-store';
import type { SaveState } from '@super-productivity/plugin-api';
import type { Command } from '../app/commands';
import type { Plan, PlanState } from '../core/plan';
import { decodeRecord, isUuid, RECORD_PREFIXES, WIPE_KEY } from '../core/records';

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

// The iframe adapter forwards the observer with the same handoff options it already uses.
export type HandoffObserver = ((message: string) => void) & Pick<Command, 'forceSync'>;

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

export async function readRecords(additionalKeys: readonly string[] = []): Promise<PlanState> {
  const missing = missingReadMethods();
  if (missing.includes('loadSyncedData')) return { entries: {} };
  const collections = missing.includes('listSyncedDataKeys')
    ? []
    : await Promise.all(RECORD_PREFIXES.map((prefix) => PluginAPI.listSyncedDataKeys(prefix)));
  // A pending local write may already be readable by key before it appears in a listing.
  const keys = new Set([...collections.flat(), WIPE_KEY, ...additionalKeys.filter(isRecordKey)]);
  const records = await Promise.all(
    [...keys].map(async (key) => [key, await PluginAPI.loadSyncedData(key)] as const),
  );
  return {
    entries: Object.fromEntries(
      records.filter((record): record is readonly [string, string] => record[1] !== null),
    ),
  };
}

export function inspectRecords({ entries }: PlanState): ReadSnapshot {
  const known: [string, string][] = [];
  let readOnlyReason: string | undefined;
  for (const [key, value] of Object.entries(entries)) {
    const decoded = decodeRecord(key, value);
    if (decoded.ok) known.push([key, value]);
    else if (decoded.reason === 'unsupported-version') {
      readOnlyReason = 'Только чтение. Обновите плагин: обнаружена неизвестная версия схемы.';
    }
  }
  return { entries: Object.fromEntries(known), ...(readOnlyReason && { readOnlyReason }) };
}

export function createHostFacade() {
  return {
    async read(additionalKeys?: readonly string[]): Promise<ReadSnapshot> {
      const snapshot = inspectRecords(await readRecords(additionalKeys));
      const readOnlyReason = snapshot.readOnlyReason ?? missingMethodsReason(missingReadMethods());
      return readOnlyReason ? { ...snapshot, readOnlyReason } : snapshot;
    },
    readSaveState(keys: string[]): Promise<SaveState> {
      return PluginAPI.getSyncedDataSaveState(keys);
    },
  };
}

export interface EditorFacade extends Facade<PlanHandoff> {
  apply(plan: Plan, onIncomplete?: HandoffObserver): Promise<PlanHandoff>;
  read(keys?: readonly string[]): Promise<ReadSnapshot>;
  readSaveState(keys: string[]): Promise<SaveState>;
}

export async function handoffGoalPlan(
  facade: EditorFacade,
  plan: Plan,
  { key, value }: Plan['writes'][number],
  onIncomplete: (message: string) => void,
  retry: boolean,
) {
  try {
    const observer = retry
      ? Object.assign(onIncomplete, { forceSync: true as const })
      : onIncomplete;
    await facade.apply(plan, observer);
    return { applied: true };
  } catch (error) {
    const refreshed = await facade.read([key]).catch(() => undefined);
    return {
      applied: refreshed?.entries[key] === value,
      message: error instanceof Error ? error.message : 'Состояние неизвестно',
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
