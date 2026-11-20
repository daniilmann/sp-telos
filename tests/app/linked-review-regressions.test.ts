import type { VNode } from 'preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EDIT_INTERVAL_MS } from '../../src/app/commands';
import { createGoalEditor } from '../../src/app/goal-editor';
import { resolveLinkedReferences } from '../../src/app/initiative-task-links';
import { buildPlan, type Plan } from '../../src/core/plan';
import { decodeRecord, WIPE_KEY, type RecordInput } from '../../src/core/records';
import { createDraftStore } from '../../src/platform/draft-store';
import { createHostFacade, type PlanHandoff } from '../../src/platform/facade';
import { linkedRecordKey } from '../../src/platform/linked-record-keys';
import { LinkForm } from '../../src/ui/links/LinkForms';
import { createFakeDraftDatabase } from '../fakes/fake-draft-database';
import {
  baseAppState,
  baseProject,
  baseTag,
  baseTask,
  collideOnLinkedKey,
  createDeferred,
  createFakeHost,
  startLinkedHost,
  versionOf,
} from '../fakes/fake-facade';

const at = Date.UTC(2026, 10, 18, 9);
const uuid = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [a, b, c] = [`kr:${uuid(1)}`, `kr:${uuid(2)}`, `kr:${uuid(3)}`] as const;
const taskKey = 'task:work';
const task = { kind: 'task-meta', taskKey, directKrKeys: [a, b] } as const;
const projectKey = 'project:initiative';
const selected = 'project:selected';
const destination = 'project:replacement';
const initiative = { kind: 'initiative', projectKey, krKey: a, initiativeType: 'one-off' } as const;
type Write = Plan['writes'][number];

beforeEach(() => vi.useFakeTimers({ now: at }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function write(key: string, record: RecordInput, id: number): Write {
  return buildPlan('manual', [{ key, base: 'absent', record }], { at, newId: () => uuid(id) })
    .writes[0]!;
}

function result({ key, value }: Write) {
  const decoded = decodeRecord(key, value);
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.value;
}

type Node = VNode<Record<string, unknown>>;

function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== 'object' || value === null || !('type' in value)) return [];
  const node = value as Node;
  if (typeof node.type === 'function')
    return nodes(Reflect.apply(node.type, undefined, [node.props]));
  return [node, ...nodes(node.props.children)];
}

async function fixture(...initial: Write[]) {
  const kr = {
    kind: 'kr',
    status: 'active',
    statement: 'Result',
    baseline: '1',
    target: '2',
    dataSource: 'Journal',
    objectiveKey: `objective:${uuid(8)}`,
    history: [],
  } as const;
  const records = [write(a, kr, 11), write(b, kr, 12), write(c, kr, 13), ...initial];
  const host = createFakeHost({
    entries: Object.fromEntries(records.map(({ key, value }) => [key, value])),
  });
  host.api.getAppState.mockResolvedValue(
    baseAppState(
      {
        initiative: baseProject('initiative', 'Existing project'),
        selected: baseProject('selected', 'Selected project'),
        replacement: baseProject('replacement', 'Replacement project'),
      },
      { team: baseTag('team'), remote: baseTag('remote') },
    ),
  );
  host.api.getTasks.mockResolvedValue([baseTask('work')]);
  const run = await startLinkedHost(host);
  const facade = createHostFacade();
  const database = createFakeDraftDatabase();
  const drafts = createDraftStore(database.factory);
  let id = 100;
  const apply = vi.fn(
    async (plan: Plan, paceEditing?: boolean) =>
      (await run.apply(plan, paceEditing)) as PlanHandoff,
  );
  const form = createGoalEditor({
    facade: { ...facade, apply: (plan, options) => apply(plan, options?.paceEditing) },
    drafts,
    now: Date.now,
    newId: () => uuid(id++),
  });
  const drain = async () => {
    await vi.advanceTimersByTimeAsync(0);
    for (const tx of database.mutations) {
      if (!tx.finished) {
        tx.succeedRequest();
        tx.complete();
        await vi.advanceTimersByTimeAsync(0);
      }
    }
  };
  const disk = (key: string) => database.committedRows('sp-telos-drafts').get(key);
  const links = await resolveLinkedReferences(
    await facade.read(),
    await facade.readBaseReferences(),
  );
  const render = (save = () => {}) =>
    nodes(
      LinkForm({
        view: form.view(),
        links,
        input: form.input,
        save,
        back: () => {},
        retry: () => {},
        draftActions: null,
      }),
    );
  const select = (id: string) => {
    const control = render().find(({ type, props }) => type === 'select' && props.id === id);
    expect(control).toBeDefined();
    return control!.props.onChange as (event: {
      currentTarget: { value?: string; selectedOptions?: { value: string }[] };
    }) => void;
  };
  const submit = () => {
    const save = vi.fn(form.save);
    const control = render(() => {
      void save();
    }).find(({ type }) => type === 'form');
    expect(control).toBeDefined();
    (control!.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault: () => {},
    });
    expect(save).toHaveBeenCalledOnce();
    return save.mock.results[0]!.value;
  };
  return { form, host, facade, apply, drain, drafts, disk, select, submit };
}

it.each([
  { action: 'removes one KR and keeps the remote addition', selection: [b], remoteKeys: [a, b, c] },
  {
    action: 'adds one KR without undoing the remote removal',
    selection: [a, b, c],
    remoteKeys: [b],
  },
])('$action', async ({ selection, remoteKeys }) => {
  const key = await linkedRecordKey(taskKey);
  const f = await fixture(write(key, task, 21));
  await f.form.open(key);
  expect(f.form.view().record).toMatchObject({ directKrKeys: [a, b] });
  f.select('direct-kr-keys')({
    currentTarget: { selectedOptions: selection.map((value) => ({ value })) },
  });
  await f.drain();
  expect(f.disk(key)).toBeDefined();

  const remote = write(key, { ...task, directKrKeys: remoteKeys }, 22);
  f.host.receiveSync(key, remote.value);
  await f.submit();
  expect(f.form.view().draftChoices).toContain('keep-draft');
  expect(f.apply).not.toHaveBeenCalled();
  await f.form.resolveDraft('keep-draft');
  await f.drain();
  await f.submit();

  const [plan] = f.apply.mock.lastCall!;
  expect(plan.writes[0]?.base).toBe(versionOf(remote));
  expect.soft(f.host.api.persistDataSynced).toHaveBeenCalledOnce();
  expect(result(plan.writes[0]!)).toHaveProperty('directKrKeys', [b, c]);
});

it('keeps the remote sphere after a confirmed sphere edit and a separate initiative edit', async () => {
  const key = await linkedRecordKey(taskKey);
  const initiativeKey = await linkedRecordKey(projectKey);
  const f = await fixture(write(key, task, 21), write(initiativeKey, initiative, 22));
  await f.form.open(key);
  f.select('Сфера')({ currentTarget: { value: 'tag:team' } });
  await f.drain();
  await f.submit();
  const [first] = f.apply.mock.lastCall!;
  expect(result(first.writes[0]!)).toMatchObject({ sphereTagKey: 'tag:team' });
  await f.host.commitAfter(Promise.resolve());
  f.host.acknowledge(key, at);
  await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);
  await vi.waitFor(
    () => {
      expect(f.form.view().status).toBe('saved');
    },
    { timeout: 2000 },
  );
  await f.drain();
  expect(f.disk(key)).toBeUndefined();

  f.select('Инициатива')({ currentTarget: { value: initiativeKey } });
  await f.drain();
  const remote = write(key, { ...task, sphereTagKey: 'tag:remote' }, 23);
  f.host.receiveSync(key, remote.value);
  await f.submit();
  expect(f.form.view().draftChoices).toContain('keep-draft');
  expect(f.apply).toHaveBeenCalledOnce();
  await f.form.resolveDraft('keep-draft');
  await f.drain();
  await f.submit();

  const [next] = f.apply.mock.lastCall!;
  expect(next.writes[0]?.base).toBe(versionOf(remote));
  expect.soft(f.host.api.persistDataSynced).toHaveBeenCalledTimes(2);
  expect(result(next.writes[0]!)).toHaveProperty('initiativeKey', initiativeKey);
  expect(result(next.writes[0]!)).toHaveProperty('sphereTagKey', 'tag:remote');
});

it.each(['opening', 'refresh', 'save', 'restore'] as const)(
  'protects a known project source at a shared key during %s',
  async (stage) => {
    const key = await linkedRecordKey(projectKey);
    await collideOnLinkedKey(projectKey);
    const owner = write(key, initiative, 21);
    const selectedRecord = write(key, { ...initiative, projectKey: selected }, 22);
    const tombstone = write(key, { deleted: true }, 23);
    const recovering = stage === 'restore' ? tombstone : selectedRecord;
    const initial = stage === 'opening' ? owner : recovering;
    const f = await fixture(initial);
    if (stage === 'opening') {
      await f.form.open(key);
      expect(f.form.view().record).toMatchObject({ projectKey });
      expect(f.form.view().readOnly).toBe(false);
    }
    if (stage === 'restore') {
      f.drafts.write(key, {
        at,
        baseVer: versionOf(selectedRecord),
        fields: {
          action: 'edit',
          projectKey: selected,
          krKey: b,
          initiativeType: 'one-off',
        },
      });
      await f.drain();
    }
    await f.form.open(await f.facade.linkedRecordKey(selected), selected);
    expect(f.form.view().key).toBe(key);
    const draft = f.disk(key);
    if (stage !== 'opening') {
      if (stage === 'save') {
        f.select('KR')({ currentTarget: { value: b } });
        await f.drain();
      }
      f.host.receiveSync(key, owner.value);
      if (stage === 'refresh') await f.form.refresh(await f.facade.read([key]), () => true);
      if (stage === 'save') await f.submit();
      if (stage === 'restore') {
        expect(f.form.view().draftChoices).toContain('restore-as-new');
        await f.form.resolveDraft('restore-as-new', destination);
        expect(f.disk(key)).toEqual(draft);
      }
    }
    expect
      .soft(f.form.view().record, 'record from the other project stays out of the form')
      .not.toEqual(expect.objectContaining({ projectKey }));
    expect
      .soft(f.form.view().readOnly, 'occupied key for a different source is read-only')
      .toBe(true);
    expect.soft(f.form.view().readOnlyReason).toBeTruthy();
    expect.soft(f.apply).not.toHaveBeenCalled();
    expect.soft(f.host.api.persistDataSynced).not.toHaveBeenCalled();
    expect(f.host.committed().entries[key]).toBe(owner.value);
  },
);

it('asks about a new wipe before rebasing a conflicting linked draft', async () => {
  const key = await linkedRecordKey(taskKey);
  const original = write(key, task, 21);
  const f = await fixture(original);
  await f.form.open(key);
  f.select('Сфера')({ currentTarget: { value: 'tag:team' } });
  await f.drain();
  const draft = f.disk(key);
  const remote = write(key, { ...task, directKrKeys: [b] }, 22);
  f.host.receiveSync(key, remote.value);
  await f.submit();
  expect(f.form.view().draftChoices).toContain('keep-draft');
  const wipe = write(WIPE_KEY, {}, 23);
  f.host.receiveSync(WIPE_KEY, wipe.value);
  await f.form.resolveDraft('keep-draft');
  await f.drain();
  expect.soft(f.disk(key)).toEqual(draft);
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.form.view().wipe?.ver).toBe(versionOf(wipe));
});

it.each(['closing', 'switching'] as const)(
  'ignores the outstanding opening after %s',
  async (navigation) => {
    const key = await linkedRecordKey(taskKey);
    const f = await fixture(write(key, task, 21));
    const load = f.host.api.loadSyncedData.getMockImplementation()!;
    const held = createDeferred();
    const release = createDeferred();
    let hold = true;
    f.host.api.loadSyncedData.mockImplementation(async (requested) => {
      const value = await load(requested);
      if (requested === key && hold) {
        hold = false;
        held.resolve();
        await release.promise;
      }
      return value;
    });
    const opening = f.form.open(key);
    await held.promise;
    if (navigation === 'closing') expect(await f.form.leave()).toBe(true);
    else await f.form.open(a);
    release.resolve();
    await opening;
    expect(f.form.view().key).toBe(navigation === 'closing' ? '' : a);
    expect(f.apply).not.toHaveBeenCalled();
  },
);
