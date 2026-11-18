import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPlan, EMPTY_STATE, type Plan, type PlanState } from '../../src/core/plan';
import { canonicalJson, decodeRecord, MODEL_VERSION } from '../../src/core/records';
import { createHostFacade } from '../../src/platform/facade';
import {
  createDeferred,
  createFakeHost,
  goalWrite,
  manualPlan,
  versionOf,
} from '../fakes/fake-facade';

async function startHost(initial?: PlanState, hasSaveMethod = true) {
  const host = createFakeHost(initial);
  vi.stubGlobal('PluginAPI', {
    ...host.api,
    getSyncedDataSaveState: hasSaveMethod ? host.api.getSyncedDataSaveState : undefined,
  });
  await import('../../src/plugin');
  await host.ready();
  return {
    ...host,
    read: createHostFacade().read,
    apply: (plan: Plan) => host.deliver({ cmd: 'apply', plan }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const original = goalWrite(1, 11);
const initial = applyPlan(EMPTY_STATE, manualPlan(original));
const edit = goalWrite(1, 12, versionOf(original));

describe('Required save method or known schema is unavailable', () => {
  it('keeps the known version readable when the save method is missing at startup', async () => {
    const host = await startHost(initial, false);
    expect(decodeRecord(original.key, (await host.read()).entries[original.key]!)).toMatchObject({
      ok: true,
      value: { ver: versionOf(original) },
    });

    const result = await host.apply(manualPlan(edit)).catch((error: unknown) => error);
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
    expect(host.committed()).toEqual(initial);
    expect(host.api.onReady).toHaveBeenCalledOnce();
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      message: expect.stringMatching(/getSyncedDataSaveState|update.*host|обнов.*основ/i),
    });
  });

  it('finds a newer synchronized schema outside writes after onReady', async () => {
    const host = await startHost(initial);
    const startupReads = host.api.loadSyncedData.mock.calls.slice();
    const later = goalWrite(2, 21);
    const newerValue = canonicalJson({
      v: MODEL_VERSION + 1,
      ver: versionOf(later),
      at: 21,
      title: 'Новый формат',
    });
    host.receiveSync(later.key, newerValue);
    const result = await host.apply(manualPlan(edit)).catch((error: unknown) => error);

    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
    expect(host.committed().entries[later.key]).toBe(newerValue);
    const planReads = host.api.loadSyncedData.mock.calls.slice(startupReads.length);
    expect(decodeRecord(original.key, (await host.read()).entries[original.key]!)).toMatchObject({
      ok: true,
      value: { ver: versionOf(original) },
    });
    expect(startupReads).toContainEqual([original.key]);
    expect(planReads).toContainEqual([later.key]);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      message: expect.stringMatching(/schema|version|схем|верси|плагин/i),
    });
  });
});

it('validates all writes before sending any', async () => {
  const host = await startHost(initial);
  const invalid = { ...goalWrite(2, 21), value: '{' };
  const result = await host.apply(manualPlan(edit, invalid)).catch((error: unknown) => error);

  expect(host.api.persistDataSynced).not.toHaveBeenCalled();
  expect(host.committed()).toEqual(initial);
  expect(result).toBeInstanceOf(Error);
  expect(result).toMatchObject({ message: expect.stringMatching(/invalid|невалид|некоррект/i) });
});

it('rejects an old plan after another write', async () => {
  const host = await startHost(initial);
  const older = goalWrite(1, 13, versionOf(original));
  await host.apply(manualPlan(edit));
  await host.commitAfter(Promise.resolve());

  await expect(host.apply(manualPlan(older))).rejects.toThrow(/stale|устар/i);
  expect(host.api.persistDataSynced.mock.calls).toEqual([[edit.value, edit.key]]);
  expect(await host.read()).toEqual(applyPlan(initial, manualPlan(edit)));
});

it.each([
  {
    name: 'uses one queue and reports partial handoff',
    base: versionOf(original),
    succeeds: false,
  },
  {
    name: 'runs the queued next plan after a partial failure',
    base: versionOf(edit),
    succeeds: true,
  },
])('$name', async ({ base, succeeds }) => {
  vi.useFakeTimers();
  const host = await startHost(initial);
  const failing = goalWrite(2, 21);
  const tail = goalWrite(3, 31);
  const next = goalWrite(1, 13, base);
  const secondHandoff = createDeferred();
  const fail = createDeferred();
  host.beforeHandoff.mockImplementation(async (key) => {
    if (key !== failing.key) return;
    secondHandoff.resolve();
    await fail.promise;
    throw new Error('Host refused the second write.');
  });

  const first = host.apply(manualPlan(edit, failing, tail));
  const firstResult = first.catch((error: unknown) => error);
  // If apply rejects before reaching a barrier, expose that error immediately.
  await Promise.race([secondHandoff.promise, first]);
  expect(host.api.persistDataSynced.mock.calls).toEqual([
    [edit.value, edit.key],
    [failing.value, failing.key],
  ]);
  const reads = host.api.loadSyncedData.mock.calls.length;
  const queued = host.apply(manualPlan(next));
  const queuedResult = queued.catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(host.api.loadSyncedData).toHaveBeenCalledTimes(reads);
    expect(host.api.persistDataSynced).toHaveBeenCalledTimes(2);
  } finally {
    fail.resolve();
    await Promise.all([firstResult, queuedResult]);
  }
  expect(await firstResult).toBeInstanceOf(Error);
  expect(await firstResult).toMatchObject({
    message: expect.stringMatching(/1\s*(?:of|из|\/)\s*3/i),
  });
  if (succeeds) {
    await expect(queued).resolves.toBeDefined();
  } else {
    await expect(queued).rejects.toThrow(/stale|устар/i);
  }

  expect(host.api.loadSyncedData.mock.calls.slice(reads)).toContainEqual([original.key]);
  expect(host.api.persistDataSynced.mock.calls.slice(2)).toEqual(
    succeeds ? [[next.value, next.key]] : [],
  );
  await host.commitAfter(Promise.resolve());
  const partial = applyPlan(initial, manualPlan(edit));
  expect(await host.read()).toEqual(succeeds ? applyPlan(partial, manualPlan(next)) : partial);
});

it('matches applyPlan after asynchronous coalesced commits', async () => {
  const other = goalWrite(2, 21);
  const base = applyPlan(initial, manualPlan(other));
  const host = await startHost(base);
  const secondEdit = goalWrite(1, 13, versionOf(edit));
  const otherEdit = goalWrite(2, 22, versionOf(other));
  const firstPlan = manualPlan(edit, otherEdit);
  const secondPlan = manualPlan(secondEdit);
  const barrier = createDeferred();
  const commit = host.commitAfter(barrier.promise);

  await Promise.all([host.apply(firstPlan), host.apply(secondPlan)]);
  expect(host.api.persistDataSynced.mock.calls).toEqual([
    [edit.value, edit.key],
    [otherEdit.value, otherEdit.key],
    [secondEdit.value, secondEdit.key],
  ]);
  expect(host.committed()).toEqual(base);
  expect(await host.api.getSyncedDataSaveState([edit.key])).toEqual({
    sync: 'ok',
    keys: { [edit.key]: { state: 'pending' } },
  });
  barrier.resolve();
  await commit;

  const expected = applyPlan(applyPlan(base, firstPlan), secondPlan);
  expect(host.commits.mock.calls).toEqual([
    [secondEdit.key, secondEdit.value],
    [otherEdit.key, otherEdit.value],
  ]);
  expect(host.committed()).toEqual(expected);
  expect(await host.read()).toEqual(expected);
  expect(await host.api.getSyncedDataSaveState([secondEdit.key])).toEqual({
    sync: 'ok',
    keys: { [secondEdit.key]: { state: 'unknown' } },
  });
  host.acknowledge(secondEdit.key, 1234);
  const expectedHash = '9124154de8210201e8192cda30a53f2ffb516d2ae70b566b503bd2718f9bb522';
  expect(await host.api.getSyncedDataSaveState([secondEdit.key])).toEqual({
    sync: 'ok',
    keys: { [secondEdit.key]: { state: 'saved', savedAt: 1234, valueSha256: expectedHash } },
  });
});
