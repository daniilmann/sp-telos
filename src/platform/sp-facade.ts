import { EDIT_INTERVAL_MS } from '../app/commands';
import { classifyPlan, type Plan } from '../core/plan';
import { inspectRecords, missingMethodsReason, missingReadMethods, readRecords } from './facade';
import type { HandoffOptions, PlanHandoff } from './facade';

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

async function applicableWrites(plan: Plan): Promise<Plan['writes']> {
  const { state, readOnlyReason } = await checkCompatibility(plan.writes.map(({ key }) => key));
  if (readOnlyReason) throw new Error(readOnlyReason);

  const classified = classifyPlan(state, plan);
  if (!classified.ok) throw new Error(rejectionMessages[classified.reason]);
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
  let writes = await applicableWrites(plan);
  if (options?.paceEditing && editCooldowns) {
    const cooldowns = writes
      .map(({ key }) => editCooldowns.get(key))
      .filter((wait) => wait !== undefined);
    if (cooldowns.length > 0) {
      await Promise.all(cooldowns);
      // Sync can replace the base while the plan waits for the write interval.
      writes = await applicableWrites(plan);
    }
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
