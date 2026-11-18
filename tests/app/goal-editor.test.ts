import type { SaveState } from '@super-productivity/plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoalEditor } from '../../src/app/goal-editor';
import { applyPlan, buildPlan, EMPTY_STATE, type Plan } from '../../src/core/plan';
import { decodeRecord, splitRecord, WIPE_KEY, type RecordInput } from '../../src/core/records';
import { createDraftStore, type Draft } from '../../src/platform/draft-store';
import { createHostFacade, inspectRecords } from '../../src/platform/facade';
import { apply, checkCompatibility } from '../../src/platform/sp-facade';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import { createFakeHost, manualPlan, versionOf } from '../fakes/fake-facade';

const at = Date.UTC(2026, 10, 18, 9, 7);
const databaseName = 'sp-telos-drafts';
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const goalKey = `annual-goal:${uuid(1)}`;
const objectiveKey = `objective:${uuid(2)}`;
const krKey = `kr:${uuid(3)}`;
const active = { status: 'active' } as const;
const goal = { ...active, kind: 'annual-goal', statement: 'Годовая цель' } as const;
const objectiveFields = { statement: 'Цель квартала', quarter: 'Q4', annualGoalKey: goalKey };
const krFields = {
  statement: 'Рабочий результат',
  baseline: '2',
  dataSource: 'Журнал',
  target: '4',
  objectiveKey,
};
const kr = { ...active, ...krFields, kind: 'kr', history: [] } as const;
function write(key: string, record: RecordInput, ver: number, base = 'absent') {
  return buildPlan('manual', [{ key, record, base }], { at, newId: () => uuid(ver) }).writes[0]!;
}
const original = write(goalKey, goal, 11);
const objective = write(objectiveKey, { ...active, ...objectiveFields, kind: 'objective' }, 12);
const initial = applyPlan(EMPTY_STATE, manualPlan(original, objective, write(krKey, kr, 13)));
const base = versionOf(original);
const remote = write(goalKey, { ...goal, statement: 'Чужой ввод' }, 21, base);
const newGoalKey = `annual-goal:${uuid(4)}`;

type Fields = Readonly<Record<string, string>>;
type Intent = { readonly action: 'create' | 'edit' | 'close' | 'revise'; readonly fields: Fields };

const edit: Intent = { action: 'edit', fields: { statement: 'Свой ввод — ё' } };
const latest: Intent = { action: 'edit', fields: { statement: 'Следующий ввод' } };
const close: Intent = { action: 'close', fields: { outcome: 'achieved', reason: 'Итог проверен' } };
const revisionReason = 'Новое измерение';
const revise: Intent = { action: 'revise', fields: { ...krFields, target: '6', revisionReason } };
const failed = 'Не сохранено на этом устройстве — перезапустите приложение';
const saved = /Сохранено в \d{2}:\d{2}/;
const poll = (ms = 1000) => vi.advanceTimersByTimeAsync(ms);
const settle = () => poll(0);

function fixture() {
  const database = createFakeDraftDatabase();
  let drafts = createDraftStore(database.factory);
  const host = createFakeHost(initial);
  vi.stubGlobal('PluginAPI', host.api);
  const facade = {
    ...createHostFacade(),
    async read(keys?: readonly string[]) {
      const { state, readOnlyReason } = await checkCompatibility(keys);
      return { ...inspectRecords(state), ...(readOnlyReason && { readOnlyReason }) };
    },
    apply: vi.fn(apply),
  };
  let nextId = 100;
  const editor = () =>
    createGoalEditor({ facade, drafts, now: Date.now, newId: () => uuid(nextId++) });
  function restart() {
    database.restart();
    drafts = createDraftStore(database.factory);
    return editor();
  }
  async function mutation() {
    await settle();
    const pending = database.mutations.filter(({ finished }) => !finished);
    expect(pending).toHaveLength(1);
    return pending[0]!;
  }
  async function drain() {
    await settle();
    for (const transaction of database.mutations) {
      if (!transaction.finished) {
        transaction.succeedRequest();
        transaction.complete();
        await settle();
      }
    }
  }
  async function open(key = goalKey) {
    const form = editor();
    await form.open(key);
    return form;
  }
  const disk = (key = goalKey): unknown => database.committedRows(databaseName).get(key);
  function put(key: string, intent: Intent, baseVer: string): Draft {
    const value = { at, baseVer, fields: { ...intent.fields, action: intent.action } };
    drafts.write(key, value);
    return value;
  }
  const lastPlan = () => facade.apply.mock.lastCall![0];
  const polls = host.api.getSyncedDataSaveState;
  const draftStore = () => drafts;
  // prettier-ignore
  return { host, facade, open, restart, mutation, drain, disk, put, draftStore, polls, lastPlan };
}
type Fixture = ReturnType<typeof fixture>;

function body(key: string, raw: string) {
  const decoded = decodeRecord(key, raw);
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.value;
}

async function submit(f: Fixture, key = goalKey, intent = edit) {
  const form = await f.open(key);
  form.input(intent);
  await f.drain();
  await form.save();
  await f.host.commitAfter(Promise.resolve());
  const sent = f.lastPlan().writes[0]!;
  expect(sent).toMatchObject({ key, base: body(key, initial.entries[key]!).ver });
  return { form, sent };
}

async function receipt(f: Fixture, key: string): Promise<SaveState> {
  f.host.acknowledge(key, at);
  return f.host.api.getSyncedDataSaveState([key]);
}

beforeEach(() => vi.useFakeTimers({ now: at }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const closureFields = ['outcome', 'reason'] as const;
// prettier-ignore
const requiredCases = [
  ['Require a statement for an annual goal', newGoalKey, 'create', edit.fields, ['statement']],
  ['Require an Objective statement and quarter', objectiveKey, 'edit', objectiveFields, ['statement', 'quarter']],
  ['Reject an incomplete KR save', krKey, 'edit', krFields, ['statement', 'baseline', 'dataSource', 'target']],
  ['Require an outcome and reason to close a KR', krKey, 'close', close.fields, closureFields],
  ['Require outcome and reason to close a goal or Objective', goalKey, 'close', close.fields, closureFields],
  ['Require outcome and reason to close a goal or Objective', objectiveKey, 'close', close.fields, closureFields],
  ['Reject a revision without a reason', krKey, 'revise', revise.fields, ['revisionReason']],
] as const;

describe.each(requiredCases)('%s', (_name, key, action, fields, required) => {
  it.each(required)('leaves the plan unsent for blank %s', async (field) => {
    const f = fixture();
    const form = await f.open(key);
    const intent = { action, fields: { ...fields, [field]: '  ' } };
    form.input(intent);
    await form.save();
    expect(form.view()).toMatchObject({ intent });
    expect(form.view().errors).toContainEqual({ field, code: 'required' });
    expect(f.facade.apply).not.toHaveBeenCalled();
  });
});

it('Save validated text during editing', async () => {
  const f = fixture();
  const form = await f.open(newGoalKey);
  const input = (statement: string) => form.input({ action: 'create', fields: { statement } });
  input('  ');
  await poll(2000);
  expect(f.facade.apply).not.toHaveBeenCalled();
  input('Начало');
  await poll(2000);
  const first = f.lastPlan().writes[0]!;
  expect(first).toMatchObject({ key: newGoalKey, base: 'absent' });
  const firstAt = body(first.key, first.value).at;
  expect(body(first.key, first.value)).toMatchObject({ statement: 'Начало' });
  input('Дальше');
  await poll(999);
  input('Последнее валидное поле');
  await poll(1000);
  expect(f.facade.apply).toHaveBeenCalledOnce();
  await poll(1);
  expect(f.facade.apply).toHaveBeenCalledTimes(2);
  const second = f.lastPlan().writes[0]!;
  expect(second.base).toBe(versionOf(first));
  const secondValue = body(second.key, second.value);
  expect(secondValue).toMatchObject({ statement: 'Последнее валидное поле' });
  expect(secondValue.at - firstAt).toBeGreaterThanOrEqual(2000);
});

describe('retries an already applied revision without duplicating history', () => {
  it.each(['lost reply', 'partial plan'] as const)('recovers after %s', async (failure) => {
    const f = fixture();
    const form = await f.open(krKey);
    form.input(revise);
    await f.drain();
    // A second revision in the same host batch can fail after the form's write reached the host.
    const sibling = `kr:${uuid(4)}`;
    const siblingOriginal = write(sibling, kr, 31);
    f.host.receiveSync(sibling, siblingOriginal.value);
    f.facade.apply.mockImplementationOnce(async (plan: Plan) => {
      if (failure === 'partial plan') {
        const target = body(krKey, plan.writes[0]!.value);
        if (!('kind' in target) || target.kind !== 'kr') throw new Error('Expected a KR');
        const { record } = splitRecord(target);
        const second = write(sibling, record, 32, versionOf(siblingOriginal));
        f.host.beforeHandoff
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('Host handoff failed'));
        return apply({ ...plan, writes: [...plan.writes, second] });
      }
      await apply(plan);
      throw new Error('Reply lost after handoff');
    });
    await form.save();
    await f.host.commitAfter(Promise.resolve());
    const applied = f.facade.apply.mock.calls[0]![0].writes[0]!;
    expect(f.host.committed().entries[krKey]).toBe(applied.value);
    expect(f.host.committed().entries[sibling]).toBe(siblingOriginal.value);
    await form.retry();
    const next = f.lastPlan();
    expect(next.origin).toBe('manual');
    expect(next.writes).toMatchObject([{ key: krKey, base: versionOf(applied) }]);
    await f.host.commitAfter(Promise.resolve());
    const committed = body(krKey, f.host.committed().entries[krKey]!);
    expect(committed).toMatchObject({
      target: '6',
      history: [{ statement: kr.statement, revisionReason }],
    });
    expect(versionOf(next.writes[0]!)).not.toBe(versionOf(applied));
  });
});

describe('Restore unconfirmed input on reopening', () => {
  it('restores the committed input for the same baseVer', async () => {
    const f = fixture();
    f.put(goalKey, edit, base);
    await f.drain();
    const form = f.restart();
    await form.open(goalKey);
    expect(form.view()).toMatchObject({ intent: edit, baseVer: base });
  });

  it('prompts before replacing a remote version', async () => {
    const f = fixture();
    const form = await f.open();
    form.input(edit);
    await f.drain();
    f.host.receiveSync(goalKey, remote.value);
    await form.save();
    expect(form.view().draftChoices).toEqual(['keep-draft', 'use-saved']);
    expect(f.facade.apply).not.toHaveBeenCalled();
    form.close();
    const reopened = f.restart();
    await reopened.open(goalKey);
    expect(reopened.view()).toMatchObject({ intent: edit, baseVer: base });
    expect(reopened.view().draftChoices).toEqual(['keep-draft', 'use-saved']);
    await reopened.resolveDraft('keep-draft');
    await reopened.save();
    expect(f.lastPlan().writes[0]!.base).toBe(versionOf(remote));
  });
});

describe('Resolve a draft after remote deletion', () => {
  it.each(['discard-draft', 'restore-as-new'] as const)('handles %s', async (choice) => {
    const f = fixture();
    const initialDraft = f.put(goalKey, edit, base);
    await f.drain();
    const tombstone = write(goalKey, { deleted: true }, 41, versionOf(original));
    f.host.receiveSync(goalKey, tombstone.value);
    const form = await f.open();
    expect(form.view().draftChoices).toEqual(['discard-draft', 'restore-as-new']);
    expect(f.disk()).toEqual(initialDraft);
    const resolving = form.resolveDraft(choice);
    await f.drain();
    await resolving;
    if (choice === 'discard-draft') {
      expect(f.disk()).toBeUndefined();
      expect(f.facade.apply).not.toHaveBeenCalled();
    } else {
      await form.save();
      const restored = f.lastPlan().writes[0]!;
      expect(restored.key).not.toBe(goalKey);
      expect(restored.base).toBe('absent');
      expect(body(restored.key, restored.value)).toMatchObject(edit.fields);
    }
    expect(f.host.committed().entries[goalKey]).toBe(tombstone.value);
  });
});

it.each(['keep', 'discard'] as const)(
  'preserves drafts after a remote wipe until the owner decides (%s)',
  async (choice) => {
    const f = fixture();
    f.put(goalKey, edit, base);
    await f.drain();
    const wipe = write(WIPE_KEY, {}, 51);
    f.host.receiveSync(WIPE_KEY, wipe.value);
    const form = await f.open();
    expect(form.view().wipe).toEqual({ ver: versionOf(wipe), count: 1 });
    expect(f.disk()).toBeDefined();
    const resolving = form.resolveWipe(choice);
    await f.drain();
    await resolving;
    expect(await f.draftStore().readWipeVersion()).toBe(versionOf(wipe));
    expect((await f.draftStore().read(goalKey)).value === undefined).toBe(choice === 'discard');
    const reopened = await f.open();
    expect(reopened.view().wipe).toBeUndefined();
  },
);

it('A committed draft survives a journal write failure', async () => {
  const f = fixture();
  const form = await f.open();
  form.input(edit);
  const transaction = await f.mutation();
  transaction.succeedRequest();
  expect(f.disk()).toBeUndefined();
  transaction.complete();
  await settle();
  expect(f.disk()).toMatchObject({ baseVer: base, fields: { ...edit.fields, action: 'edit' } });
  f.host.api.persistDataSynced.mockResolvedValueOnce(undefined);
  await form.save();
  expect(f.host.api.persistDataSynced).toHaveBeenCalledOnce();
  f.polls.mockResolvedValue({ sync: 'ok', keys: { [goalKey]: { state: 'failed' } } });
  await poll();
  expect(form.view()).toMatchObject({ message: failed, intent: edit });
  form.close();
  const reopened = f.restart();
  await reopened.open(goalKey);
  expect(reopened.view()).toMatchObject({ intent: edit });
});

describe('Clear only the acknowledged draft', () => {
  it.each([
    [goalKey, edit],
    [goalKey, close],
    [krKey, revise],
  ] as const)('commits deletion only after confirming %s', async (key, intent) => {
    const f = fixture();
    const { form, sent } = await submit(f, key, intent);
    await f.drain();
    expect(f.disk(key)).toMatchObject({
      baseVer: versionOf(sent),
      fields: { ...intent.fields, action: intent.action },
    });
    f.polls.mockResolvedValueOnce(await receipt(f, key));
    await poll();
    const deletion = await f.mutation();
    deletion.succeedRequest();
    expect(f.disk(key)).toBeDefined();
    deletion.complete();
    await settle();
    expect(form.view().message).toMatch(saved);
    expect(f.disk(key)).toBeUndefined();
  });

  const mismatch = ['baseVer', 'fields', 'action'] as const;
  describe.each(['first removal', 'retry'] as const)('%s', (stage) => {
    it.each(mismatch)('rechecks %s at the transaction boundary', async (part) => {
      const f = fixture();
      const retry = stage === 'retry';
      const key = retry ? krKey : goalKey;
      const current = retry ? revise : close;
      const { form, sent } = await submit(f, key, current);
      await f.drain();
      f.polls.mockResolvedValue(await receipt(f, key));
      if (retry) {
        await poll();
        (await f.mutation()).abort();
        await settle();
      }
      const reason = retry ? 'revisionReason' : 'reason';
      const candidates = {
        action: { ...current, action: 'edit' as const },
        fields: { ...current, fields: { ...current.fields, [reason]: 'Новая причина' } },
        baseVer: current,
      };
      const draftBase = part === 'baseVer' ? sent.base : versionOf(sent);
      const next = f.put(key, candidates[part], draftBase);
      const waitingWrite = await f.mutation();
      if (retry) {
        const retrying = form.retryDraftRemoval();
        await f.drain();
        await retrying;
      } else {
        await poll();
        expect(await f.mutation()).toBe(waitingWrite);
        await f.drain();
      }
      expect(f.disk(key)).toEqual(next);
    });
  });
});

describe('A newer draft intent arrives during deletion', () => {
  it.each(['complete', 'abort'] as const)(
    'survives old deletion %s and a refused write',
    async (outcome) => {
      const f = fixture();
      const { form, sent } = await submit(f);
      await f.drain();
      f.polls.mockResolvedValueOnce(await receipt(f, goalKey));
      await poll();
      const deletion = await f.mutation();
      deletion.succeedRequest();
      form.input(latest);
      deletion[outcome]();
      await settle();
      // A failed delete may leave the latest write pending until the next explicit flush.
      const flushed = f.draftStore().flush();
      (await f.mutation()).exceedQuota();
      expect(await flushed).toMatchObject({ ok: false, reason: 'failed' });
      form.close();
      expect((await f.open()).view()).toMatchObject({ intent: latest, baseVer: versionOf(sent) });
      const retried = f.draftStore().flush();
      await f.drain();
      expect(await retried).toEqual({ ok: true });
      const reopened = f.restart();
      await reopened.open(goalKey);
      expect(reopened.view()).toMatchObject({ intent: latest, baseVer: versionOf(sent) });
    },
  );
});
