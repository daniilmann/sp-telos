// The only path to host writes. Every change goes through apply(plan).
import { applyPlan, EMPTY_STATE, type Plan, type PlanState } from '../core/plan';

export interface Facade {
  read(): Promise<PlanState>;
  apply(plan: Plan): Promise<PlanState>;
}

const STATE_KEY = 'state';

function parseState(raw: string | null): PlanState {
  if (raw === null) return EMPTY_STATE;
  try {
    const value = JSON.parse(raw) as { entries?: unknown };
    if (typeof value.entries !== 'object' || value.entries === null) return EMPTY_STATE;
    const entries = Object.entries(value.entries).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    return { entries: Object.fromEntries(entries) };
  } catch {
    return EMPTY_STATE;
  }
}

export function createHostFacade(): Facade {
  let tail: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<PlanState> =>
    parseState(await PluginAPI.loadSyncedData(STATE_KEY));
  return {
    read,
    apply(plan) {
      // Plans run strictly one after another; a failed plan does not block the next.
      const run = async (): Promise<PlanState> => {
        const next = applyPlan(await read(), plan);
        await PluginAPI.persistDataSynced(JSON.stringify(next), STATE_KEY);
        return next;
      };
      const result = tail.then(run, run);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
