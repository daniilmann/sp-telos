import { classifyPlan, type Plan } from '../core/plan';
import { inspectRecords, missingMethodsReason, missingReadMethods, readRecords } from './facade';
import type { PlanHandoff } from './facade';

const HOST_METHODS = [
  'onReady',
  'onMessage',
  'persistDataSynced',
  'getSyncedDataSaveState',
  'triggerSync',
] as const;

export function hostMethodsReason(): string | undefined {
  return missingMethodsReason([
    ...missingReadMethods(),
    ...HOST_METHODS.filter((method) => typeof PluginAPI[method] !== 'function'),
  ]);
}

export async function checkCompatibility(keys?: readonly string[]) {
  const state = await readRecords(keys);
  const { readOnlyReason } = inspectRecords(state);
  return { state, readOnlyReason: hostMethodsReason() ?? readOnlyReason };
}

const rejectionMessages = {
  stale: 'План устарел.',
  invalid: 'Некорректный план записи.',
  size: 'Запись превышает допустимый размер.',
  history: 'План нарушает правила истории KR.',
  'unsupported-version': 'Обновите плагин: неизвестная версия схемы плана.',
};

export async function apply(plan: Plan): Promise<PlanHandoff> {
  const { state, readOnlyReason } = await checkCompatibility(plan.writes.map(({ key }) => key));
  if (readOnlyReason) throw new Error(readOnlyReason);

  const classified = classifyPlan(state, plan);
  if (!classified.ok) throw new Error(rejectionMessages[classified.reason]);

  let transferred = 0;
  const total = plan.writes.length;
  for (const { key, value } of classified.writes) {
    try {
      await PluginAPI.persistDataSynced(value, key);
    } catch {
      throw new Error(
        `Основе передано ${String(transferred)} из ${String(total)} записей. Следующий план в очереди начнётся с перечитывания данных.`,
      );
    }
    transferred += 1;
  }

  return { transferred, total, writes: plan.writes };
}
