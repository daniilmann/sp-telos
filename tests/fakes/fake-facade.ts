import {
  applyPlan,
  classifyPlan,
  EMPTY_STATE,
  type Plan,
  type PlanState,
} from '../../src/core/plan';
import type { Facade } from '../../src/platform/facade';

export interface AppliedPlan {
  readonly plan: Plan;
  readonly at: number;
}

export interface FakeFacade extends Facade {
  readonly applied: readonly AppliedPlan[];
  now(): number;
  advance(ms: number): void;
}

/** In-memory facade with a manual clock: time moves only through advance(). */
export function createFakeFacade(initial: PlanState = EMPTY_STATE, startAt = 0): FakeFacade {
  let state = initial;
  let clock = startAt;
  const applied: AppliedPlan[] = [];
  return {
    applied,
    now: () => clock,
    advance(ms) {
      clock += ms;
    },
    read: () => Promise.resolve(state),
    apply(plan) {
      const classified = classifyPlan(state, plan);
      if (!classified.ok) {
        return Promise.reject(new Error(classified.reason));
      }
      if (classified.writes.length > 0) {
        state = applyPlan(state, plan);
        applied.push({ plan, at: clock });
      }
      return Promise.resolve(state);
    },
  };
}
