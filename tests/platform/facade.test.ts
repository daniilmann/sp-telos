import { build } from 'esbuild';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  isValidElement,
  toChildArray,
  type ComponentChildren,
  type FunctionComponent,
  type VNode,
} from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoalEditor } from '../../src/app/goal-editor';
import { applyPlan, EMPTY_STATE, type Plan, type PlanState } from '../../src/core/plan';
import { canonicalJson, decodeRecord, MODEL_VERSION } from '../../src/core/records';
import { createDraftStore } from '../../src/platform/draft-store';
import { createHostFacade, type PlanHandoff } from '../../src/platform/facade';
import { GoalForm } from '../../src/ui/goals/GoalForm';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import {
  createDeferred,
  createFakeHost,
  goalWrite,
  manualPlan,
  versionOf,
} from '../fakes/fake-facade';
import { input, openSaveStatusEditor } from '../fakes/save-status-editor';

async function startHost(
  initial?: PlanState,
  hasSaveMethod = true,
  loadPlugin: () => Promise<unknown> = () => import('../../src/plugin'),
) {
  const host = createFakeHost(initial);
  vi.stubGlobal('PluginAPI', {
    ...host.api,
    getSyncedDataSaveState: hasSaveMethod ? host.api.getSyncedDataSaveState : undefined,
  });
  await loadPlugin();
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

    await expect(host.apply(manualPlan(edit))).rejects.toThrow(
      /getSyncedDataSaveState|update.*host|обнов.*основ/i,
    );
    expect(host.api.persistDataSynced).not.toHaveBeenCalled();
    expect(host.committed()).toEqual(initial);
    expect(host.api.onReady).toHaveBeenCalledOnce();
  });

  it.each([
    ['finds a newer synchronized schema outside writes after onReady', MODEL_VERSION + 1, false],
    ['finds a newer measurement outside writes after onReady', 3, true],
    ['finds a measurement without v outside writes after onReady', undefined, true],
  ])('%s', async (_title, v, measurement) => {
    const host = await startHost(initial);
    const { loadSyncedData, persistDataSynced, triggerSync } = host.api;
    expect(loadSyncedData).toHaveBeenCalledWith(original.key);
    const later = goalWrite(2, 21);
    const envelope = { v, ver: versionOf(later), at: 21 };
    const body = {
      ...envelope,
      kind: 'kr-value',
      krKey: 'kr:00000000-0000-4000-8000-000000000022',
      value: 'Наблюдение',
    };
    const key = measurement ? 'kr-value:00000000-0000-4000-8000-000000000021' : later.key;
    const knownKey = 'kr-value:00000000-0000-4000-8000-000000000023';
    const known = canonicalJson({ ...body, v: 2, ver: versionOf(goalWrite(3, 31)) });
    const record = canonicalJson(measurement ? body : { ...envelope, title: 'Новый формат' });
    host.receiveSync(key, record);
    if (measurement) host.receiveSync(knownKey, known);
    loadSyncedData.mockClear();
    const result = host.deliver({ cmd: 'apply', plan: manualPlan(edit), forceSync: true });
    await expect.soft(result).rejects.toThrow(/schema|version|схем|верси|плагин/i);
    expect.soft(loadSyncedData).toHaveBeenCalledWith(key);
    expect.soft(persistDataSynced).not.toHaveBeenCalled();
    expect.soft(triggerSync).not.toHaveBeenCalled();
    expect(host.committed().entries[key]).toBe(record);
    const { entries } = await host.read();
    expect.soft(entries).toEqual({ ...initial.entries, ...(measurement && { [knownKey]: known }) });
    const originalRecord = decodeRecord(original.key, entries[original.key]!);
    expect(originalRecord).toMatchObject({ ok: true, value: { ver: versionOf(original) } });
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
  const expectedHash = createHash('sha256').update(secondEdit.value, 'utf8').digest('hex');
  expect(await host.api.getSyncedDataSaveState([secondEdit.key])).toEqual({
    sync: 'ok',
    keys: { [secondEdit.key]: { state: 'saved', savedAt: 1234, valueSha256: expectedHash } },
  });
});

interface FormElementProps {
  readonly children?: ComponentChildren;
  readonly disabled?: boolean;
  readonly type?: string;
  readonly onSubmit?: (event: Pick<Event, 'preventDefault'>) => void;
}

function* formElements(tree: ComponentChildren): Generator<VNode<FormElementProps>> {
  for (const child of toChildArray(tree)) {
    if (!isValidElement(child)) continue;
    const node = child as VNode<FormElementProps>;
    if (typeof node.type === 'function') {
      yield* formElements((node.type as FunctionComponent<FormElementProps>)(node.props));
    } else {
      yield node;
      yield* formElements(node.props.children);
    }
  }
}

function pressSave(form: Awaited<ReturnType<typeof openSaveStatusEditor>>['form']) {
  const save = vi.fn(() => form.save());
  const tree = GoalForm({
    view: form.view(),
    records: {},
    input: form.input,
    save: () => {
      void save();
    },
    retry: () => {
      void form.retry();
    },
    back: () => {
      void form.leave();
    },
  });
  const fields = [...formElements(tree)].find((node) => node.type === 'form');
  const button = [...formElements(fields?.props.children)].find(
    (node) => node.type === 'button' && node.props.type === 'submit',
  );
  expect(button?.props).toMatchObject({ children: 'Сохранить', disabled: false });
  // Activating an enabled submit button runs the form's onSubmit handler.
  fields?.props.onSubmit?.({ preventDefault: () => undefined });
  expect(save).toHaveBeenCalledOnce();
  return save.mock.results[0]!.value;
}

it('paces two manual saves of the same key at the two-second boundary', async () => {
  const at = 10_000;
  vi.useFakeTimers({ now: at });
  const f = await openSaveStatusEditor(initial, original.key, at);
  const handedOffAt: number[] = [];
  f.host.beforeHandoff.mockImplementation(() => {
    handedOffAt.push(Date.now());
    return Promise.resolve();
  });
  const { form } = f;
  const latest = { ...input, fields: { statement: 'Следующий ввод' } };
  expect(form.input(input)).toBe(true);
  await f.commitDrafts();
  await pressSave(form);
  await f.host.commitAfter(Promise.resolve());
  const first = f.facade.apply.mock.lastCall![0].writes[0]!;
  expect(handedOffAt).toEqual([at]);

  await vi.advanceTimersByTimeAsync(100);
  expect(form.input(latest)).toBe(true);
  await f.commitDrafts();
  await vi.advanceTimersByTimeAsync(1899);
  const secondSave = pressSave(form);
  await vi.advanceTimersByTimeAsync(0);
  expect.soft(handedOffAt).toEqual([at]);

  await vi.advanceTimersByTimeAsync(1);
  await secondSave;
  expect(handedOffAt).toEqual([at, at + 2000]);
  expect(f.facade.apply.mock.lastCall![0].writes).toMatchObject([
    { key: original.key, base: versionOf(first) },
  ]);
  const second = f.facade.apply.mock.lastCall![0].writes[0]!;
  expect(decodeRecord(second.key, second.value)).toMatchObject({ ok: true, value: latest.fields });
});

it('paces editor writes from the first host call after a queue delay', async () => {
  vi.useFakeTimers({ now: 10_000 });
  // Build plugin.js in memory so the test can run before the release build.
  const plugin = await build({
    entryPoints: ['src/plugin.ts'],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    write: false,
  });
  const script = Buffer.from(plugin.outputFiles[0]!.contents).toString('base64');
  const host = await startHost(
    initial,
    true,
    () => import(`data:text/javascript;base64,${script}#${crypto.randomUUID()}`),
  );
  const form = createGoalEditor({
    facade: {
      ...createHostFacade(),
      apply: (plan) => host.apply(plan) as Promise<PlanHandoff>,
    },
    drafts: createDraftStore(createFakeDraftDatabase().factory),
    now: Date.now,
    newId: () => crypto.randomUUID(),
  });
  await form.open(original.key);

  const writeTimes: number[] = [];
  host.beforeHandoff.mockImplementation((key) => {
    if (key === original.key) writeTimes.push(Date.now());
    return Promise.resolve();
  });
  const entered = createDeferred();
  const release = createDeferred();
  host.beforeHandoff.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const ahead = host.apply(manualPlan(goalWrite(2, 21)));
  const latest = { ...input, fields: { statement: 'Следующее изменение' } };

  try {
    await Promise.race([entered.promise, ahead]);
    expect(form.input(input)).toBe(true);
    const firstSave = pressSave(form);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.deliver).toHaveBeenCalledWith({
      cmd: 'apply',
      plan: expect.objectContaining({ writes: [expect.objectContaining({ key: original.key })] }),
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(writeTimes).toEqual([]);
    expect(form.input(latest)).toBe(true);

    const firstWriteAt = Date.now();
    release.resolve();
    await ahead;
    await firstSave;
    await host.commitAfter(Promise.resolve());
    expect(writeTimes).toEqual([firstWriteAt]);
    expect(decodeRecord(original.key, host.committed().entries[original.key]!)).toMatchObject({
      ok: true,
      value: input.fields,
    });
    expect(form.view()).toMatchObject({ busy: false, intent: latest });

    const secondSave = pressSave(form);
    await vi.advanceTimersByTimeAsync(1999);
    const beforeBoundary = [...writeTimes];
    await vi.advanceTimersByTimeAsync(1);
    expect({ beforeBoundary, atBoundary: writeTimes }).toEqual({
      beforeBoundary: [firstWriteAt],
      atBoundary: [firstWriteAt, firstWriteAt + 2000],
    });
    await secondSave;
    await host.commitAfter(Promise.resolve());
    expect(decodeRecord(original.key, host.committed().entries[original.key]!)).toMatchObject({
      ok: true,
      value: latest.fields,
    });
  } finally {
    release.resolve();
    form.close();
  }
});

it.each([
  ['absent', undefined],
  ['string', '10000'],
  ['nonfinite', Number.NaN],
  ['outside the date range', 8.64e15 + 1],
] as const)('shows unknown and keeps the draft when receipt time is %s', async (_name, time) => {
  const at = 10_000;
  vi.useFakeTimers({ now: at });
  const f = await openSaveStatusEditor(initial, original.key, at);
  const current = await f.submit();
  const confirmed = current.keys[original.key];
  if (confirmed?.state !== 'saved') throw new Error('Expected a valid fixture receipt');
  // The receipt still carries the real matching digest.
  const malformed = { ...confirmed, savedAt: time };
  if (time === undefined) Reflect.deleteProperty(malformed, 'savedAt');
  f.host.api.getSyncedDataSaveState.mockResolvedValue({
    ...current,
    keys: { [original.key]: malformed as typeof confirmed },
  });
  await vi.advanceTimersByTimeAsync(1000);
  await f.commitDrafts();
  expect(f.disk()).toMatchObject({ fields: input.fields });
  expect(f.form.view().message).toBe('Состояние неизвестно');
});
