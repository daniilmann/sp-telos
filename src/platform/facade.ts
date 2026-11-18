import type { SaveState } from '@super-productivity/plugin-api';
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
