import type { Plan, PlanState } from '../core/plan';
import { RECORD_PREFIXES, WIPE_KEY } from '../core/records';

export interface Facade {
  read(): Promise<PlanState>;
  apply(plan: Plan): Promise<PlanState>;
}

export function createHostFacade(): Facade {
  return {
    async read() {
      const collections = await Promise.all(
        RECORD_PREFIXES.map((prefix) => PluginAPI.listSyncedDataKeys(prefix)),
      );
      const keys = new Set([...collections.flat(), WIPE_KEY]);
      const records = await Promise.all(
        [...keys].map(async (key) => [key, await PluginAPI.loadSyncedData(key)] as const),
      );
      return {
        entries: Object.fromEntries(
          records.filter((record): record is readonly [string, string] => record[1] !== null),
        ),
      };
    },
    apply() {
      return Promise.reject(new Error('Writing to the host is unavailable.'));
    },
  };
}
