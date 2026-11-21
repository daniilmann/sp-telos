import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest';
import { draftError } from '../../src/app/commands';
import { createKrValueEditor, type KrValueEditor as Editor } from '../../src/app/kr-values';
import type { Plan } from '../../src/core/plan';
import * as records from '../../src/core/records';
import { createDraftStore, type Draft } from '../../src/platform/draft-store';
import * as platform from '../../src/platform/facade';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import { createDeferred, createFakeHost, startLinkedHost, versionOf } from '../fakes/fake-facade';

const at = Date.UTC(2026, 10, 18, 9, 7);
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const krKey = `kr:${uuid(1)}`;
const otherKr = `kr:${uuid(2)}`;
const factKey = (n: number) => `kr-value:${uuid(n)}`;
const body = {
  kind: 'kr',
  objectiveKey: `objective:${uuid(3)}`,
  statement: 'Результат',
  baseline: '2',
  target: '4',
  dataSource: 'Журнал',
};
const closure = { status: 'closed', outcome: 'achieved', closureReason: 'Итог проверен' };
const version = (id: number) => ({ at, v: 2, ver: uuid(id) });
const closed = records.canonicalJson({
  ...body,
  ...closure,
  ...version(11),
  history: [{ ...body, ...closure, target: '3', revisionReason: 'Уточнение' }],
});
const legacy = records.canonicalJson({
  ...body,
  ...version(12),
  status: 'active',
  v: 1,
  history: [],
});
const value = 'Практика устойчива три недели';
const saved = /Сохранено в \d{2}:\d{2}/;
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const fact = (text: string, kr = krKey, ver = uuid(13)) =>
  records.canonicalJson({ kind: 'kr-value', krKey: kr, value: text, at, ver, v: 2 });
const tombstone = records.canonicalJson({ ...version(40), deleted: true });

async function fixture(extra: platform.ReadSnapshot['entries'] = {}) {
  const initial = { [krKey]: closed, [otherKr]: legacy, ...extra };
  const host = createFakeHost({ entries: initial });
  await startLinkedHost(host);
  const boundary = platform.createHostFacade();
  const apply = async (plan: Plan, options?: platform.HandoffOptions) =>
    (await host.deliver({ cmd: 'apply', plan, ...options })) as platform.PlanHandoff;
  const facade = {
    ...boundary,
    read: vi.fn(boundary.read),
    apply: vi.fn(apply),
  };
  const db = createFakeDraftDatabase();
  let drafts = createDraftStore(db.factory);
  let nextId = 100;
  const rows = () => db.committedRows('sp-telos-drafts');
  const disk = (key: string) => rows().get(key) as Draft | undefined;
  async function mutation(key: string) {
    await tick();
    const pending = db.mutations.filter(({ finished }) => !finished);
    expect(pending.map(({ pendingKeys }) => pendingKeys)).toEqual([[key]]);
    return pending[0]!;
  }
  async function finish(operation?: Promise<unknown>) {
    await tick();
    for (const transaction of db.mutations) {
      if (transaction.finished) continue;
      transaction.succeedRequest();
      transaction.complete();
      await tick();
    }
    await operation;
  }
  async function open(key = krKey) {
    const newId = () => uuid(nextId++);
    const editor = createKrValueEditor({ facade, drafts, now: Date.now, newId });
    await editor.open(key);
    return editor;
  }
  function restart(editor: Editor) {
    editor.close();
    db.restart();
    drafts = createDraftStore(db.factory);
    return open();
  }
  async function refresh(editor: Editor) {
    await editor.beginRefresh()(await facade.read());
  }
  function sent() {
    const [plan, options] = facade.apply.mock.lastCall!;
    expect(plan).toMatchObject({ origin: 'manual', writes: [{ base: 'absent' }] });
    const write = plan.writes[0]!;
    return { ...write, plan, options: { ...options }, ver: versionOf(write) };
  }
  const local = { disk, rows, mutation, finish, drafts: () => drafts };
  return { initial, host, facade, local, open, restart, refresh, sent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function enter(f: Fixture, form: Editor, text = value) {
  form.input(text);
  await f.local.finish();
  return form.view().draftKey!;
}

async function submit(f: Fixture, form: Editor) {
  await enter(f, form);
  await f.local.finish(form.save());
}

async function observe(f: Fixture, form: Editor) {
  await f.host.commitAfter(Promise.resolve());
  await f.local.finish(f.refresh(form));
  return f.sent();
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: at });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('rejects blank and oversized input and accepts the exact UTF-8 record limit', async () => {
  const f = await fixture();
  const form = await f.open();
  const limit = records.MAX_RECORD_BYTES - records.recordByteLength(fact(''));
  const boundary = 'я'.repeat(Math.floor(limit / 2)) + 'x'.repeat(limit % 2);
  for (const invalid of ['', ' \t\n', boundary + 'я']) {
    form.input(invalid);
    await f.local.finish(form.save());
    expect(form.view().value).toBe(invalid);
    expect(form.view().errors.length).toBeGreaterThan(0);
    expect(f.facade.apply).not.toHaveBeenCalled();
  }
  form.input(boundary);
  await f.local.finish(form.save());
  expect(records.recordByteLength(f.sent().value)).toBe(records.MAX_RECORD_BYTES);
});

it('warns about an aborted draft write before submitting', async () => {
  const f = await fixture();
  const form = await f.open();
  form.input(value);
  const key = form.view().draftKey!;
  (await f.local.mutation(key)).abort();
  await tick();
  expect((await f.local.drafts().read(key)).failed).toBe(true);
  await form.checkDraft();
  expect(form.view()).toMatchObject({ value, draftMessage: draftError });
  expect(f.local.disk(key)).toBeUndefined();
  expect(f.facade.apply).not.toHaveBeenCalled();
});

const revocations = ['rotation', 'tombstone', 'absent', 'late poll'] as const;
it.each(revocations)('records independently and rechecks the receipt (%s)', async (change) => {
  const f = await fixture();
  const form = await f.open();
  const key = await enter(f, form, '0');
  const fields = { krKey, value: '0', action: 'record-kr-value', expectedWipe: 'absent' };
  expect(f.local.disk(key)).toMatchObject({ fields });
  expect(f.facade.apply).not.toHaveBeenCalled();
  const saving = form.save();
  const local = await f.local.mutation(key);
  local.succeedRequest();
  await tick();
  expect(f.facade.apply).not.toHaveBeenCalled();
  const release = createDeferred();
  f.host.beforeHandoff.mockReturnValueOnce(release.promise);
  local.complete();
  await tick();
  const first = f.sent();
  expect(first.value).toBe(fact('0', krKey, first.ver));
  const draft = { baseVer: 'absent', fields: { ...fields, plan: first.plan } };
  expect(f.local.disk(key)).toMatchObject(draft);
  const duplicate = form.save();
  await tick();
  expect(f.facade.apply).toHaveBeenCalledOnce();
  release.resolve();
  await Promise.all([saving, duplicate]);
  await observe(f, form);
  f.host.acknowledge(key, at + 500);
  await vi.waitUntil(() => saved.test(form.view().message), 2000);
  const confirmedRemoval = await f.local.mutation(key);
  confirmedRemoval.succeedRequest();
  expect(f.local.disk(key)).toBeDefined();
  confirmedRemoval.complete();
  expect(f.local.disk(key)).toBeUndefined();
  await tick();
  expect(form.view().message).toMatch(saved);
  const latePoll = createDeferred();
  if (change === 'late poll') {
    const stale = await f.facade.read();
    const poll = f.host.api.getSyncedDataSaveState;
    poll.mockResolvedValueOnce(await poll([key]));
    f.facade.read.mockClear();
    f.facade.read.mockReturnValueOnce(latePoll.promise.then(() => stale));
    await tick(5000);
    expect(f.facade.read).toHaveBeenCalledWith([key, krKey]);
  }
  const rotation = change === 'rotation';
  if (rotation || change === 'absent')
    f.host.receiveImport(rotation ? f.host.committed().entries : f.initial);
  else f.host.receiveSync(key, tombstone);
  await (rotation ? tick(5000) : f.refresh(form));
  expect(form.view().measurements).toMatchObject(rotation ? [{ key, value: '0' }] : []);
  expect(form.view().message).toBe('');
  latePoll.resolve();
  await tick();
  expect(form.view()).toMatchObject({ message: '', value: '', retry: false });
  expect(form.view().draftKey).toBeUndefined();
  expect(f.local.rows().size).toBe(0);
  form.input('0');
  await f.local.finish(form.save());
  const second = await observe(f, form);
  expect(second.key).not.toBe(key);
  const shown = Object.fromEntries(form.view().measurements.map((m) => [m.key, m.value]));
  expect(shown).toEqual({ ...(rotation && { [key]: '0' }), [second.key]: '0' });
  expect(f.host.api.persistDataSynced).toHaveBeenCalledTimes(2);
  expect(f.host.committed().entries[krKey]).toBe(closed);
});

it('refreshes facts, retains input and keeps compatible data readable', async () => {
  const f = await fixture({ [factKey(3)]: fact('другой', otherKr) });
  const form = await f.open();
  await enter(f, form);
  const late = form.beginRefresh();
  const old = await f.facade.read();
  // The view supplies the same snapshot callback for dataChanged, persistedDataChanged and Refresh.
  for (const [index, text] of ['0', '12,5 кг', value].entries()) {
    const id = index + 4;
    f.host.receiveSync(factKey(id), fact(text));
    await f.refresh(form);
    expect(form.view().measurements.find((m) => m.key === factKey(id))?.value).toBe(text);
    expect(form.view().value).toBe(value);
  }
  const current = structuredClone(form.view().measurements);
  await late(old);
  expect(form.view().measurements).toEqual(current);
  f.host.receiveSync(factKey(4), tombstone);
  f.host.receiveSync(factKey(7), fact('future', otherKr).replace('"v":2', '"v":3'));
  await f.refresh(form);
  expect(form.view().measurements.map(({ key }) => key)).not.toContain(factKey(4));
  expect(form.view().readOnlyReason).toMatch(/неизвестная версия схемы/i);
  await f.local.finish(form.save());
  await form.open(otherKr);
  expect(form.view().measurements.map(({ key }) => key)).toEqual([factKey(3)]);
  expect(f.facade.apply).not.toHaveBeenCalled();
});

it('reopens after journal failure and retries the original unobserved plan once', async () => {
  const f = await fixture();
  const form = await f.open();
  f.host.beforeHandoff.mockRejectedValueOnce(new Error('Journal write failed'));
  await submit(f, form);
  const first = f.sent();
  expect(form.view().message).toBe('Не сохранено на этом устройстве — перезапустите приложение');
  expect(f.local.disk(first.key)).toMatchObject({
    baseVer: 'absent',
    fields: { plan: first.plan },
  });
  const reopened = await f.restart(form);
  expect(reopened.view()).toMatchObject({ value, draftKey: first.key });
  f.host.api.persistDataSynced.mockClear();
  await reopened.retry();
  expect(f.sent()).toMatchObject({
    plan: first.plan,
    options: { byteCheck: 'allow-absent', forceSync: true },
  });
  expect(f.host.api.persistDataSynced.mock.calls).toEqual([[first.value, first.key]]);
  expect(f.host.api.triggerSync).toHaveBeenCalledOnce();
});

it.each([false, true])('binds observed bytes before import (read-only %s)', async (readOnly) => {
  const ver = uuid(80);
  const f = await fixture({ [records.WIPE_KEY]: records.canonicalJson({ at, v: 2, ver }) });
  f.local.drafts().writeWipeVersion(ver);
  await f.local.finish();
  const form = await f.open();
  const key = await enter(f, form);
  const handoff = f.facade.apply.getMockImplementation()!;
  f.facade.apply.mockImplementationOnce(async (...args) => {
    await handoff(...args);
    if (readOnly) f.host.receiveSync(factKey(7), fact('future', otherKr).replace('"v":2', '"v":3'));
    throw new Error('Состояние неизвестно');
  });
  const saving = form.save();
  const planCommit = await f.local.mutation(key);
  planCommit.succeedRequest();
  planCommit.complete();
  const observation = await f.local.mutation(key);
  const sent = f.sent();
  expect(f.facade.read).toHaveBeenCalledWith([key]);
  expect(await f.host.api.listSyncedDataKeys('kr-value:')).not.toContain(key);
  const before = f.local.disk(key);
  expect(before).toMatchObject({
    baseVer: 'absent',
    fields: { plan: sent.plan, expectedWipe: ver },
  });
  observation.succeedRequest();
  const premature = form.retry();
  await tick();
  expect(f.facade.apply).toHaveBeenCalledOnce();
  observation.complete();
  await Promise.all([saving, premature]);
  const marked = f.local.disk(key);
  expect(marked).toEqual({ ...before, baseVer: sent.ver });
  if (readOnly) expect(form.view().readOnlyReason).toMatch(/неизвестная версия схемы/i);
  expect(form.view().measurements).toMatchObject([{ key, value }]);
  await f.host.commitAfter(Promise.resolve());
  f.host.receiveImport(f.initial);
  const reopened = await f.restart(form);
  expect(reopened.view()).toMatchObject({ value, draftKey: key, measurements: [] });
  f.host.api.persistDataSynced.mockClear();
  f.host.api.triggerSync.mockClear();
  await reopened.retry();
  expect(f.sent()).toMatchObject({
    plan: sent.plan,
    options: { expectedWipe: ver, byteCheck: 'require-exact', forceSync: true },
  });
  expect(f.host.api.persistDataSynced).not.toHaveBeenCalled();
  expect(f.host.api.triggerSync).not.toHaveBeenCalled();
  expect(f.local.disk(key)).toEqual(marked);
});

it('keeps a visible fact after revocation and discards only the local draft', async () => {
  const f = await fixture();
  const form = await f.open();
  await submit(f, form);
  const sent = await observe(f, form);
  const unchanged = f.host.committed().entries;
  const polls = f.host.api.getSyncedDataSaveState;
  f.host.acknowledge(sent.key, at + 500);
  expect((await polls([sent.key])).keys[sent.key]?.state).toBe('saved');
  f.host.receiveImport(unchanged);
  const reopened = await f.restart(form);
  await tick(21_000);
  const unconfirmed = 'Сохранение не подтверждено · Повторить';
  expect(reopened.view()).toMatchObject({ value, message: unconfirmed });
  const before = f.local.disk(sent.key);
  await reopened.retry();
  expect(f.sent()).toMatchObject({
    plan: sent.plan,
    options: { byteCheck: 'require-exact', forceSync: true },
  });
  expect(f.host.api.triggerSync).toHaveBeenCalledOnce();
  expect(f.host.api.persistDataSynced.mock.calls).toEqual([[sent.value, sent.key]]);
  const otherKey = await enter(f, await f.open(otherKr), 'Другой ввод');
  const otherBefore = f.local.disk(otherKey);
  expect(otherBefore).toBeDefined();
  const removing = reopened.discard();
  const deletion = await f.local.mutation(sent.key);
  deletion.succeedRequest();
  await tick();
  expect(reopened.view()).toMatchObject({ value, draftKey: sent.key });
  expect(f.local.disk(sent.key)).toEqual(before);
  deletion.complete();
  await removing;
  expect(reopened.view().value).toBe('');
  expect(f.local.disk(sent.key)).toBeUndefined();
  expect(f.local.disk(otherKey)).toEqual(otherBefore);
  expect(f.facade.apply).toHaveBeenCalledTimes(2);
  expect(f.host.committed().entries).toEqual(unchanged);
});

const variants = ['digest', 'version', 'edit', 'switch', 'pause', 'close', 'draft'] as const;
it.each(variants)('retains drafts across a stale or mismatched receipt (%s)', async (variant) => {
  const f = await fixture();
  const form = await f.open();
  await submit(f, form);
  const { key } = await observe(f, form);
  f.host.acknowledge(key, at + 500);
  const polls = f.host.api.getSyncedDataSaveState;
  const receipt = await polls([key]);
  const target = receipt.keys[key]!;
  assert(target.state === 'saved', 'Expected a genuine receipt for the fixture');
  polls.mockClear();
  const reply = createDeferred();
  polls.mockImplementationOnce(async () => {
    await reply.promise;
    if (variant === 'digest')
      return { ...receipt, keys: { [key]: { ...target, valueSha256: '0'.repeat(64) } } };
    return receipt;
  });
  await vi.waitUntil(() => polls.mock.calls.some(([keys]) => keys.includes(key)), 2000);
  if (variant === 'version') f.host.receiveSync(key, fact(value, krKey, uuid(79)));
  if (variant === 'edit') {
    form.input('Промежуточный текст');
    await enter(f, form);
  }
  if (variant === 'switch') await form.open(otherKr);
  if (variant === 'pause') form.pause();
  if (variant === 'close') form.close();
  if (variant === 'draft') {
    const draft = f.local.disk(key)!;
    const fields = { ...draft.fields, value: 'Новое намерение' };
    f.local.drafts().write(key, { ...draft, fields });
    await f.local.finish();
  }
  const { key: selected, value: input } = form.view();
  const drafts = f.local.rows();
  reply.resolve();
  await tick();
  if (variant !== 'draft') expect(form.view().message).not.toMatch(saved);
  expect(form.view()).toMatchObject({ key: selected, value: input });
  await f.local.finish();
  expect(f.local.rows()).toEqual(drafts);
});
