import {
  EDIT_INTERVAL_MS,
  includesKrValueWrite,
  isKrValuePreconditions,
  krValueWrite,
} from '../app/commands';
import { classifyPlan, type Plan, type PlanState } from '../core/plan';
import { decodeRecord, isBaseKey, WIPE_KEY, type StoredRecord } from '../core/records';
import { BASE_READ_METHODS, readBaseReferences, type BaseReferences } from './base-references';
import { missingMethodsReason, missingReadMethods, readRecords } from './facade';
import type { HandoffOptions, PlanHandoff } from './facade';
import { linkedRecordSource, matchesLinkedRecord } from './linked-record-keys';

const HOST_METHODS = [
  'onReady',
  'onMessage',
  'persistDataSynced',
  'getSyncedDataSaveState',
  'triggerSync',
  ...BASE_READ_METHODS,
] as const;

export function hostMethodsReason(): string | undefined {
  return missingMethodsReason([
    ...missingReadMethods(),
    ...HOST_METHODS.filter((method) => typeof PluginAPI[method] !== 'function'),
  ]);
}

export async function checkCompatibility(keys?: readonly string[]) {
  const state = await readRecords(keys);
  return { state, readOnlyReason: hostMethodsReason() ?? state.readOnlyReason };
}

const rejectionMessages = {
  stale: 'План устарел.',
  invalid: 'Некорректный план записи.',
  size: 'Запись превышает допустимый размер.',
  history: 'План нарушает правила истории KR.',
  'unsupported-version': 'Обновите плагин: неизвестная версия схемы плана.',
};

function assignmentKeys(record?: StoredRecord): string[] {
  if (!record || !('kind' in record)) return [];
  switch (record.kind) {
    case 'kr-value':
      return [record.krKey];
    case 'initiative':
      return [record.projectKey, record.krKey];
    case 'task-meta':
      return [
        record.taskKey,
        ...(record.initiativeKey ? [record.initiativeKey] : []),
        ...(record.sphereTagKey ? [record.sphereTagKey] : []),
        ...(record.directKrKeys ?? []),
      ];
    case 'annual-goal':
    case 'objective':
      return record.sphereTagKey ? [record.sphereTagKey] : [];
    case 'kr':
      return [];
  }
}

function storedRecord(state: PlanState, key: string): StoredRecord | undefined {
  const raw = state.entries[key];
  if (raw === undefined) return undefined;
  const decoded = decodeRecord(key, raw);
  return decoded.ok ? decoded.value : undefined;
}

async function newAssignments(state: PlanState, { key, value }: Plan['writes'][number]) {
  const target = decodeRecord(key, value);
  if (!target.ok) throw new Error(rejectionMessages[target.reason]);
  const current = storedRecord(state, key);
  const source = linkedRecordSource(target.value);
  if (
    source !== undefined &&
    !(await matchesLinkedRecord(key, source, linkedRecordSource(current) ?? source))
  ) {
    throw new Error('Некорректный ключ или исходная ссылка записи.');
  }
  const existing = new Set(assignmentKeys(current));
  return assignmentKeys(target.value).filter((reference) => !existing.has(reference));
}

function baseGroup(reference: string): keyof BaseReferences | undefined {
  if (isBaseKey(reference, 'project')) return 'projects';
  if (isBaseKey(reference, 'task')) return 'tasks';
  if (isBaseKey(reference, 'tag')) return 'tags';
  return undefined;
}

async function verifyAssignments(state: PlanState, writes: Plan['writes']): Promise<void> {
  const references = (
    await Promise.all(writes.map((write) => newAssignments(state, write)))
  ).flat();
  const final = {
    entries: {
      ...state.entries,
      ...Object.fromEntries(writes.map(({ key, value }) => [key, value])),
    },
  };
  const groups = new Set<keyof BaseReferences>();
  for (const reference of references) {
    const group = baseGroup(reference);
    if (group) {
      groups.add(group);
    } else {
      const record = storedRecord(final, reference);
      if (!record || !('kind' in record)) throw new Error('Новая ссылка Telos недоступна.');
    }
  }
  if (groups.size === 0) return;
  const base = await readBaseReferences([...groups]);
  for (const reference of references) {
    const group = baseGroup(reference);
    if (group && base[group]?.[reference] === undefined)
      throw new Error('Новая ссылка на объект основы недоступна.');
  }
}

async function applicableWrites(plan: Plan, options?: HandoffOptions): Promise<Plan['writes']> {
  const keys = plan.writes.map(({ key }) => key);
  let measurement;
  if (
    includesKrValueWrite(plan) ||
    (options && ('expectedWipe' in options || 'byteCheck' in options))
  ) {
    const write = krValueWrite(plan);
    if (!write || !isKrValuePreconditions(options)) throw new Error(rejectionMessages.invalid);
    measurement = { write, expectedWipe: options.expectedWipe, byteCheck: options.byteCheck };
    keys.push(write.krKey);
  }
  const { state, readOnlyReason } = await checkCompatibility(keys);
  if (readOnlyReason) throw new Error(readOnlyReason);

  if (measurement) {
    const { expectedWipe, byteCheck, write } = measurement;
    if ((storedRecord(state, WIPE_KEY)?.ver ?? 'absent') !== expectedWipe) {
      throw new Error('Маркер очистки изменился.');
    }
    if (byteCheck === 'require-exact' && state.entries[write.key] !== write.value) {
      throw new Error(rejectionMessages.stale);
    }
  }
  const classified = classifyPlan(state, plan);
  if (!classified.ok) throw new Error(rejectionMessages[classified.reason]);
  await verifyAssignments(state, classified.writes);
  return classified.writes;
}

function startEditCooldown(editCooldowns: Map<string, Promise<void>>, key: string): void {
  const cooldown = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (editCooldowns.get(key) === cooldown) editCooldowns.delete(key);
      resolve();
    }, EDIT_INTERVAL_MS);
  });
  editCooldowns.set(key, cooldown);
}

export async function apply(
  plan: Plan,
  options?: HandoffOptions,
  editCooldowns?: Map<string, Promise<void>>,
): Promise<PlanHandoff> {
  // The interval can end while the asynchronous first check is still reading records.
  const cooldowns = options?.paceEditing
    ? plan.writes.map(({ key }) => editCooldowns?.get(key)).filter((wait) => wait !== undefined)
    : [];
  let writes = await applicableWrites(plan, options);
  if (writes.length > 0 && cooldowns.length > 0) {
    await Promise.all(cooldowns);
    // Sync can replace the base while the plan waits for the write interval.
    writes = await applicableWrites(plan, options);
  }

  let transferred = 0;
  const total = plan.writes.length;
  for (const { key, value } of writes) {
    try {
      const handoff = PluginAPI.persistDataSynced(value, key);
      if (editCooldowns) startEditCooldown(editCooldowns, key);
      await handoff;
    } catch {
      throw new Error(
        `Основе передано ${String(transferred)} из ${String(total)} записей. Следующий план в очереди начнётся с перечитывания данных.`,
      );
    }
    transferred += 1;
  }

  if (options?.forceSync) {
    void Promise.resolve()
      .then(() => PluginAPI.triggerSync())
      .catch(() => {
        // Save-state polling reports sync availability independently of handoff.
      });
  }
  return { transferred, total, writes: plan.writes };
}
