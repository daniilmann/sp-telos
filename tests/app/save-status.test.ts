import type { SaveState } from '@super-productivity/plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSaveStatus } from '../../src/app/save-status';
import { createGoalEditor } from '../../src/app/goal-editor';
import { applyPlan, EMPTY_STATE, type Plan } from '../../src/core/plan';
import { canonicalJson } from '../../src/core/records';
import { createDraftStore } from '../../src/platform/draft-store';
import { createHostFacade, inspectRecords } from '../../src/platform/facade';
import { apply, checkCompatibility } from '../../src/platform/sp-facade';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import {
  createDeferred,
  createFakeHost,
  goalWrite,
  manualPlan,
  versionOf,
} from '../fakes/fake-facade';

const a = goalWrite(1, 11);
const b = goalWrite(1, 12, versionOf(a));
const extra = goalWrite(2, 21);
const initial = applyPlan(EMPTY_STATE, manualPlan(a));
const savedAt = Date.UTC(2026, 10, 18, 9, 7);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

type Tracking = { readonly formId: string; readonly generation: number; readonly planId: string };
type SaveStatus =
  | { readonly state: 'saved'; readonly savedAt: number }
  | { readonly state: 'changed' | 'pending' | 'replaced' | 'unknown' | 'retry' | 'failed' };

function keyState(state: SaveState['keys'][string], sync: SaveState['sync'] = 'ok'): SaveState {
  return { sync, keys: { [a.key]: state } };
}

async function fixture(plan = manualPlan(b)) {
  const host = createFakeHost(initial);
  vi.stubGlobal('PluginAPI', host.api);
  host.acknowledge(a.key, savedAt - 1000);
  const receiptA = await host.api.getSyncedDataSaveState([a.key]);
  const applied = applyPlan(initial, plan);
  for (const { key } of plan.writes) {
    host.receiveSync(key, applied.entries[key]!);

    host.acknowledge(key, savedAt);
  }
  const receiptB = await host.api.getSyncedDataSaveState(plan.writes.map(({ key }) => key));
  host.api.getSyncedDataSaveState.mockClear();

  const onStatus = vi.fn<(status: SaveStatus) => void>();
  const identity: Tracking = { formId: 'form-a', generation: 1, planId: 'plan-b' };
  const status: {
    track(tracking: Tracking, plan: Plan): Promise<void>;
    invalidate(formId: string, generation: number): void;
    close(formId: string): void;
  } = createSaveStatus({ ...createHostFacade(), now: Date.now, onStatus });

  await status.track(identity, plan);
  return {
    host,
    status,
    identity,
    receiptA,
    receiptB,
    onStatus,
    last: () => onStatus.mock.lastCall?.[0],
    polls: host.api.getSyncedDataSaveState,
  };
}

beforeEach(() => vi.useFakeTimers({ now: savedAt }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('Confirm the current version after server acknowledgement', async () => {
  const { polls, receiptB, onStatus, last } = await fixture(manualPlan(b, extra));
  polls.mockResolvedValueOnce({
    ...receiptB,
    keys: { ...receiptB.keys, [extra.key]: { state: 'pending' } },
  });
  await advance(1000);
  expect(last()).toEqual({ state: 'pending' });
  expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'saved' }));

  polls.mockResolvedValueOnce(receiptB);
  await advance(1000);
  expect(last()).toEqual({ state: 'saved', savedAt });
  expect(polls.mock.calls).toEqual([[[b.key, extra.key]], [[b.key, extra.key]]]);
});

describe('Wait for acknowledgement', () => {
  it.each(['pending', 'unknown'] as const)(
    'waits for %s up to the 20-second boundary',
    async (state) => {
      const { polls, last } = await fixture();
      polls.mockResolvedValue(keyState({ state }));
      await advance(19_999);
      expect(last()).toEqual({ state: 'pending' });
      await advance(1);
      expect(last()).toEqual({ state: 'retry' });
    },
  );
});

it('A newer version replaces the submitted value', async () => {
  const { host, polls, receiptB, last } = await fixture();
  const remote = goalWrite(1, 13, versionOf(b));
  polls.mockResolvedValueOnce(receiptB);
  host.receiveSync(a.key, remote.value);
  await advance(1000);
  expect(last()).toEqual({ state: 'replaced' });
});

describe('The version changes between status and value reads', () => {
  it.each([
    { name: 'A receipt, separately read B', snapshot: 'A', read: b, expected: 'pending' },
    { name: 'A value, B receipt', snapshot: 'B', read: a, expected: 'replaced' },
    { name: 'ABA B → A → B', snapshot: 'A', read: b, expected: 'pending' },
  ])('$name', async ({ name, snapshot, read, expected }) => {
    const { host, polls, receiptA, receiptB, onStatus, last } = await fixture();
    host.receiveSync(a.key, read.value);
    if (name.startsWith('ABA')) expect(await host.api.loadSyncedData(b.key)).toBe(b.value);
    host.api.loadSyncedData.mockClear();
    polls.mockImplementationOnce(() => {
      // Keep the acknowledgement tied to its snapshot, independently of the readable value.
      host.receiveSync(a.key, snapshot === 'A' ? a.value : b.value);
      const reply = snapshot === 'A' ? receiptA : receiptB;
      host.receiveSync(a.key, read.value);
      return Promise.resolve(reply);
    });
    await advance(1000);
    expect(host.api.loadSyncedData).toHaveBeenCalledWith(b.key);
    expect(last()).toEqual({ state: expected });
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'saved' }));
  });
});

describe('A saved reply has no valid fingerprint', () => {
  it.each([undefined, 'BAD', 'A'.repeat(64)])('treats %s as unconfirmed', async (valueSha256) => {
    const { polls, onStatus, last } = await fixture();
    // A malformed message can arrive at the typed host boundary.
    const reply = {
      state: 'saved',
      savedAt,
      ...(valueSha256 === undefined ? {} : { valueSha256 }),
    };
    polls.mockResolvedValue(keyState(reply as SaveState['keys'][string]));
    await advance(1000);
    expect(last()).toEqual({ state: 'pending' });
    await advance(19_000);
    expect(last()).toEqual({ state: 'retry' });
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'saved' }));
  });
});

it('clears the visible confirmation on the first completed post-import poll', async () => {
  const { host, polls, receiptB, last } = await fixture();
  polls.mockResolvedValueOnce(receiptB);
  await advance(1000);
  expect(last()).toEqual({ state: 'saved', savedAt });
  const postImport = createDeferred();
  polls.mockImplementationOnce(async () => {
    await postImport.promise;
    return keyState({ state: 'unknown' });
  });
  await advance(4999);
  expect(polls).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(polls).toHaveBeenCalledTimes(2);
  expect(last()).toEqual({ state: 'saved', savedAt });
  expect(host.committed().entries[b.key]).toBe(b.value);
  postImport.resolve();
  await advance(0);
  expect(last()).toEqual({ state: 'pending' });
});

describe('Local write or status lookup fails', () => {
  it.each(['journal', 'RPC'] as const)('reports the %s failure', async (cause) => {
    const { polls, last } = await fixture();
    if (cause === 'journal') polls.mockResolvedValueOnce(keyState({ state: 'failed' }));
    else polls.mockRejectedValueOnce(new Error('Host lock timed out'));
    await advance(1000);
    expect(last()).toEqual({ state: cause === 'journal' ? 'failed' : 'unknown' });
  });
});

it.each(['error', 'offline'] as const)(
  'offers an immediate retry when sync is %s',
  async (sync) => {
    const { polls, last } = await fixture();
    polls.mockResolvedValueOnce(keyState({ state: 'pending' }, sync));
    await advance(1000);
    expect(last()).toEqual({ state: 'retry' });
  },
);

it.each(['planId', 'formId'] as const)(
  'polls once at a time and ignores responses for an old plan (%s)',
  async (field) => {
    const { identity, status, polls, receiptB, onStatus } = await fixture();
    const blocked = createDeferred();
    polls
      .mockImplementationOnce(async () => {
        await blocked.promise;
        return receiptB;
      })
      .mockResolvedValue(keyState({ state: 'pending' }));
    await advance(1000);
    expect(polls).toHaveBeenCalledTimes(1);
    // Same bytes, generation and target version, with just one identity dimension changed.
    await status.track({ ...identity, [field]: 'new-id' }, manualPlan(b));
    await advance(7000);
    expect(polls).toHaveBeenCalledTimes(1);
    blocked.resolve();
    await advance(0);
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'saved' }));
    await advance(999);
    expect(polls).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(polls).toHaveBeenCalledTimes(2);
  },
);

describe('New input or closing the view invalidates a delayed reply', () => {
  it.each(['input', 'same text again', 'close'] as const)(
    'ignores the response after %s',
    async (action) => {
      const { identity, status, polls, receiptB, onStatus, last } = await fixture();
      const blocked = createDeferred();
      polls.mockImplementationOnce(async () => {
        await blocked.promise;
        return receiptB;
      });
      await advance(1000);
      expect(polls).toHaveBeenCalledOnce();
      if (action === 'close') status.close(identity.formId);
      else {
        status.invalidate(identity.formId, 2);
        if (action === 'same text again') status.invalidate(identity.formId, 3);
        expect(last()).toEqual({ state: 'changed' });
      }
      blocked.resolve();
      await advance(5000);
      expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'saved' }));
      expect(polls).toHaveBeenCalledOnce();
    },
  );
});

async function editorFixture() {
  const host = createFakeHost(initial);
  const database = createFakeDraftDatabase();
  const drafts = createDraftStore(database.factory);
  vi.stubGlobal('PluginAPI', host.api);
  const facade = {
    ...createHostFacade(),
    apply: vi.fn(apply),
    async read() {
      const { state, readOnlyReason } = await checkCompatibility([a.key]);
      return { ...inspectRecords(state), ...(readOnlyReason && { readOnlyReason }) };
    },
  };
  const form = createGoalEditor({
    facade,
    drafts,
    now: Date.now,
    newId: () => crypto.randomUUID(),
  });
  await form.open(a.key);
  async function commitDrafts() {
    await advance(0);
    for (const transaction of database.mutations) {
      if (transaction.finished) continue;
      transaction.succeedRequest();
      transaction.complete();
      await advance(0);
    }
  }
  async function submit() {
    form.input(input);
    await commitDrafts();
    await form.save();
    await host.commitAfter(Promise.resolve());
    host.acknowledge(a.key, savedAt);
    return host.api.getSyncedDataSaveState([a.key]);
  }
  const disk = () => database.committedRows('sp-telos-drafts').get(a.key);
  return { host, facade, form, database, commitDrafts, submit, disk };
}

const input = { action: 'edit', fields: { statement: 'Локальный ввод' } } as const;
const newInput = { ...input, fields: { statement: 'Текст после запроса' } };
const savedMessage = /^Сохранено в /;

it('Server unavailable and save retried', async () => {
  const f = await editorFixture();
  await f.submit();
  f.host.api.getSyncedDataSaveState.mockResolvedValue(keyState({ state: 'pending' }, 'offline'));
  await advance(1000);
  expect(f.form.view()).toMatchObject({
    message: 'Не сохранено на сервере · Повторить',
    intent: input,
  });
  expect(f.disk()).toMatchObject({ fields: input.fields });
  f.host.api.triggerSync.mockClear();
  await f.form.retry();
  const [first, retry] = f.facade.apply.mock.calls.map(([plan]) => plan.writes[0]!);
  expect(retry).toMatchObject({ base: versionOf(first!) });
  expect(versionOf(retry!)).not.toBe(versionOf(first!));
  expect(f.host.api.triggerSync).toHaveBeenCalledOnce();
  await f.host.commitAfter(Promise.resolve());
  expect(f.host.committed().entries[a.key]).toContain(input.fields.statement);
});

describe('Unconfirmed plans retain the editor draft', () => {
  // prettier-ignore
  const cases = [
    ['A newer version replaces the submitted value', 'matching-sha', 'Заменено другой версией'],
    ['The version changes between status and value reads', 'A receipt, B value', 'Сохраняется…'],
    ['The version changes between status and value reads', 'A value, B receipt', 'Заменено другой версией'],
    ['The version changes between status and value reads', 'ABA B → A → B', 'Сохраняется…'],
    ['A saved reply has no valid fingerprint', 'absent-sha', 'Сохраняется…'],
    ['A saved reply has no valid fingerprint', 'malformed-sha', 'Сохраняется…'],
    ['Import rotates the client ID during hashing or before host response', 'revoked', 'Сохраняется…'],
  ] as const;

  describe.each(cases)('%s', (_name, scenario, message) => {
    it(scenario, async () => {
      const f = await editorFixture();
      f.host.acknowledge(a.key, savedAt - 1);
      const old = await f.host.api.getSyncedDataSaveState([a.key]);
      const current = await f.submit();
      const target = f.host.committed().entries[a.key]!;
      const receipt = { state: 'saved', savedAt, valueSha256: 'bad' } as const;
      f.host.api.getSyncedDataSaveState.mockImplementationOnce(() => {
        if (scenario === 'A receipt, B value' || scenario === 'ABA B → A → B') {
          f.host.receiveSync(a.key, a.value);
          f.host.receiveSync(a.key, target);
          return Promise.resolve(old);
        }
        if (scenario === 'absent-sha') {
          return Promise.resolve(
            keyState({ state: 'saved', savedAt } as SaveState['keys'][string]),
          );
        }
        if (scenario === 'malformed-sha') return Promise.resolve(keyState(receipt));
        if (scenario === 'revoked') return Promise.resolve(keyState({ state: 'unknown' }));
        return Promise.resolve(current);
      });
      if (scenario === 'A value, B receipt') f.host.receiveSync(a.key, a.value);
      if (scenario === 'matching-sha')
        f.host.receiveSync(a.key, goalWrite(1, 15, versionOf(b)).value);
      await advance(1000);
      await f.commitDrafts();
      expect(f.form.view().message).toBe(message);
      expect(f.disk()).toMatchObject({ fields: input.fields });
    });
  });
});

describe('New input or closing the view invalidates a delayed reply', () => {
  it.each(['edit', 'revert', 'close'] as const)('retains the draft after %s', async (action) => {
    const f = await editorFixture();
    const current = await f.submit();
    const barrier = createDeferred();
    f.host.api.getSyncedDataSaveState.mockImplementationOnce(async () => {
      await barrier.promise;
      return current;
    });
    await advance(1000);
    if (action === 'close') f.form.close();
    else f.form.input(newInput);
    if (action === 'revert') f.form.input(input);
    barrier.resolve();
    await f.commitDrafts();
    expect(f.form.view().message ?? '').not.toMatch(savedMessage);
    expect(f.disk()).toMatchObject({ fields: action === 'edit' ? newInput.fields : input.fields });
  });
});

describe('Import revokes confirmation for identical data', () => {
  it('cancels queued cleanup', async () => {
    const f = await editorFixture();
    const confirmed = await f.submit();
    f.host.api.getSyncedDataSaveState
      .mockResolvedValueOnce(confirmed)
      .mockResolvedValue(keyState({ state: 'unknown' }));
    await advance(1000);
    expect(f.form.view().message).toMatch(savedMessage);
    expect(f.database.mutations.filter((tx) => !tx.finished)).toHaveLength(1);
    await advance(5000);
    expect(f.form.view().message).toBe('Сохраняется…');
    await f.commitDrafts();
    expect(f.disk()).toMatchObject({ fields: input.fields });
  });
});

describe('Required save method or known schema is unavailable', () => {
  it.each(['method', 'schema'] as const)(
    'keeps the goal readable with an incompatible %s',
    async (cause) => {
      const f = await editorFixture();
      if (cause === 'method')
        vi.stubGlobal('PluginAPI', { ...f.host.api, getSyncedDataSaveState: undefined });
      else
        f.host.receiveSync(extra.key, canonicalJson({ v: 2, ver: versionOf(extra), at: savedAt }));
      await f.form.open(a.key);
      expect(f.form.view().intent.fields.statement).toBe('Цель 11');
      expect(f.form.view().message).toMatch(/Только чтение.*Обновите/);
      f.form.input(input);
      await f.form.save();
      expect(f.host.api.persistDataSynced).not.toHaveBeenCalled();
    },
  );
});

it('Report a local draft failure', async () => {
  const f = await editorFixture();
  f.form.input(input);
  const leaving = f.form.leave();
  await advance(0);
  f.database.mutations[0]!.exceedQuota();
  expect(await leaving).toBe(false);
  expect(f.form.view()).toMatchObject({
    intent: input,
    leaveChoices: ['retry', 'stay', 'discard'],
  });
  expect(f.form.view().message).toMatch(/Черновик.*не сохр/);
  expect(await f.form.leave('stay')).toBe(false);
  expect(await f.form.leave('discard')).toBe(true);
});
