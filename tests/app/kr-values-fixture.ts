import { expect, vi } from 'vitest';
import { createKrValueEditor, type KrValueEditor as Editor } from '../../src/app/kr-values';
import type { Plan } from '../../src/core/plan';
import * as records from '../../src/core/records';
import { createDraftStore, type Draft } from '../../src/platform/draft-store';
import * as platform from '../../src/platform/facade';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import { createFakeHost, startLinkedHost, versionOf } from '../fakes/fake-facade';

export const at = Date.UTC(2026, 10, 18, 9, 7);
export const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const krKey = `kr:${uuid(1)}`;
export const otherKr = `kr:${uuid(2)}`;
export const factKey = (n: number) => `kr-value:${uuid(n)}`;
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
export const closed = records.canonicalJson({
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
export const value = 'Практика устойчива три недели';
export const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
export const fact = (text: string, kr = krKey, ver = uuid(13)) =>
  records.canonicalJson({ kind: 'kr-value', krKey: kr, value: text, at, ver, v: 2 });
export const tombstone = records.canonicalJson({ ...version(40), deleted: true });

export async function fixture(extra: platform.ReadSnapshot['entries'] = {}) {
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
  async function peerMutation(key: string, draft?: Draft) {
    const peer = await new Promise<IDBDatabase>((resolve) => {
      const opening = db.factory.open('sp-telos-drafts');
      opening.onsuccess = () => {
        resolve(opening.result);
      };
    });
    db.beforeNextReadwrite(() => {
      const store = peer.transaction('drafts', 'readwrite').objectStore('drafts');
      if (draft) store.put(draft, key);
      else store.delete(key);
    });
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
  const local = { disk, rows, mutation, finish, peerMutation, drafts: () => drafts };
  return { initial, host, facade, db, local, open, restart, refresh, sent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function enter(f: Fixture, form: Editor, text = value) {
  form.input(text);
  await f.local.finish();
  return form.view().draftKey!;
}

export async function submit(f: Fixture, form: Editor) {
  await enter(f, form);
  await f.local.finish(form.save());
}

export async function observe(f: Fixture, form: Editor) {
  await f.host.commitAfter(Promise.resolve());
  await f.local.finish(f.refresh(form));
  return f.sent();
}
