// Pure plan model: no clock, randomness, timers, DOM or host API.

export interface PlanState {
  readonly entries: Readonly<Record<string, string>>;
}

export type PlanOp =
  | { readonly kind: 'set'; readonly key: string; readonly value: string }
  | { readonly kind: 'remove'; readonly key: string };

export interface Plan {
  readonly ops: readonly PlanOp[];
}

export const EMPTY_STATE: PlanState = { entries: {} };

/** Returns a new state with the plan applied; the input state is never mutated. */
export function applyPlan(state: PlanState, plan: Plan): PlanState {
  let entries: Record<string, string> = { ...state.entries };
  for (const op of plan.ops) {
    if (op.kind === 'set') {
      entries[op.key] = op.value;
    } else {
      entries = Object.fromEntries(Object.entries(entries).filter(([key]) => key !== op.key));
    }
  }
  return { entries };
}
