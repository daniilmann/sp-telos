import { describe, expect, it } from 'vitest';
import { applyPlan, type Plan, type PlanState } from '../../src/core/plan';
import { createFakeFacade } from '../fakes/fake-facade';

const plan: Plan = {
  ops: [
    { kind: 'set', key: 'a', value: '1' },
    { kind: 'set', key: 'b', value: '2' },
    { kind: 'remove', key: 'a' },
  ],
};

describe('applyPlan', () => {
  it('gives the same result on two independent state copies', () => {
    const original: PlanState = { entries: { a: '0', c: '3' } };
    const first = structuredClone(original);
    const second = structuredClone(original);

    const fromFirst = applyPlan(first, plan);
    const fromSecond = applyPlan(second, plan);

    expect(fromFirst).toEqual({ entries: { b: '2', c: '3' } });
    expect(fromSecond).toEqual(fromFirst);
    expect(first).toEqual(original);
    expect(second).toEqual(original);
  });
});

describe('fake facade', () => {
  it('applies plans in memory and stamps them with the manual clock', async () => {
    const facade = createFakeFacade(undefined, 1000);
    await facade.apply(plan);
    facade.advance(500);
    await facade.apply({ ops: [{ kind: 'set', key: 'c', value: '4' }] });

    expect(await facade.read()).toEqual({ entries: { b: '2', c: '4' } });
    expect(facade.applied.map((p) => p.at)).toEqual([1000, 1500]);
    expect(facade.now()).toBe(1500);
  });
});
