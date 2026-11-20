import { assert, describe, expect, it } from 'vitest';
const loadOperations = () => import('../../src/core/initiative-task-links');

const projectKey = 'project:PrOj-é';
const taskKey = 'task:rpt_🚀';
const krKey = 'kr:00000000-0000-4000-8000-000000000001';
const secondKrKey = 'kr:00000000-0000-4000-8000-000000000002';
const unavailableKrKey = 'kr:00000000-0000-4000-8000-000000000003';
const initiativeKey = 'initiative:183803da-3882-5fec-aec2-e3a6d6978a1f';
const sphereTagKey = 'tag:Семья';
const available = {
  projectKeys: new Set([projectKey]),
  taskKeys: new Set([taskKey]),
  krKeys: new Set([krKey, secondKrKey]),
  initiativeKeys: new Set([initiativeKey]),
  sphereTagKeys: new Set([sphereTagKey]),
};
const regularDraft = Object.freeze({
  projectKey,
  krKey,
  initiativeType: 'regular',
  cadence: 'Каждый понедельник',
});
const regular = Object.freeze({ kind: 'initiative', ...regularDraft });
const taskMeta = Object.freeze({
  kind: 'task-meta',
  taskKey,
  initiativeKey,
  sphereTagKey,
  directKrKeys: Object.freeze([krKey, unavailableKrKey]),
});

function expectFieldError(result: unknown, field: string): void {
  expect(result).toMatchObject({
    ok: false,
    errors: expect.arrayContaining([expect.objectContaining({ field })]),
  });
  expect(result).not.toHaveProperty('value');
}

describe('Reject incomplete initiative choices', () => {
  it.each([
    ['projectKey', ''],
    ['projectKey', 'project:missing'],
    ['krKey', ''],
    ['krKey', unavailableKrKey],
    ['cadence', ''],
    ['cadence', ' \t\n'],
  ] as const)('reports the invalid %s choice %j', async (field, value) => {
    const { createInitiative } = await loadOperations();
    expectFieldError(createInitiative({ ...regularDraft, [field]: value }, available), field);
  });

  it('rejects an input that supplies multiple key results', async () => {
    const { createInitiative } = await loadOperations();
    const draft = { ...regularDraft, krKey: [krKey, secondKrKey] };
    const result: unknown = Reflect.apply(createInitiative, undefined, [draft, available]);
    expectFieldError(result, 'krKey');
  });

  it('creates an initiative with exactly one available KR', async () => {
    const { createInitiative } = await loadOperations();
    expect(createInitiative(regularDraft, available)).toStrictEqual({ ok: true, value: regular });
  });

  it('removes cadence on an explicit change to one-off, even with unavailable retained links', async () => {
    const { updateInitiative } = await loadOperations();
    const partial = { ...available, projectKeys: new Set<string>(), krKeys: new Set<string>() };
    const result = updateInitiative(regular, { initiativeType: 'one-off' }, partial);
    expect(result).toStrictEqual({
      ok: true,
      value: { kind: 'initiative', projectKey, krKey, initiativeType: 'one-off' },
    });
    expect(regular.cadence).toBe(regularDraft.cadence);
  });

  it('keeps the original project, type and cadence when the KR changes', async () => {
    const { updateInitiative } = await loadOperations();
    const partial = {
      ...available,
      projectKeys: new Set<string>(),
      krKeys: new Set([secondKrKey]),
    };
    expect(updateInitiative(regular, { krKey: secondKrKey }, partial)).toStrictEqual({
      ok: true,
      value: { ...regular, krKey: secondKrKey },
    });
    expectFieldError(updateInitiative(regular, { krKey: unavailableKrKey }, available), 'krKey');
    expectFieldError(updateInitiative(regular, { cadence: ' ' }, available), 'cadence');
  });
});

describe('Remove and reassign individual task links', () => {
  const partial = { ...available, taskKeys: new Set<string>() };

  it('removes links independently and keeps the empty live record assignable', async () => {
    const { updateTaskLinks } = await loadOperations();
    const removedInitiative = updateTaskLinks(taskKey, taskMeta, { initiativeKey: null }, partial);
    const withoutInitiative = {
      kind: 'task-meta',
      taskKey,
      sphereTagKey,
      directKrKeys: [krKey, unavailableKrKey],
    };
    expect(removedInitiative).toStrictEqual({ ok: true, value: withoutInitiative });
    assert(removedInitiative.ok);

    const removedOneKr = updateTaskLinks(
      taskKey,
      removedInitiative.value,
      { directKrKeys: [unavailableKrKey] },
      partial,
    );
    expect(removedOneKr).toStrictEqual({
      ok: true,
      value: { ...withoutInitiative, directKrKeys: [unavailableKrKey] },
    });
    assert(removedOneKr.ok);

    const clearedKrs = updateTaskLinks(taskKey, removedOneKr.value, { directKrKeys: [] }, partial);
    expect(clearedKrs).toStrictEqual({
      ok: true,
      value: { ...withoutInitiative, directKrKeys: [] },
    });
    assert(clearedKrs.ok);

    const clearedSphere = updateTaskLinks(
      taskKey,
      clearedKrs.value,
      { sphereTagKey: null },
      partial,
    );
    expect(clearedSphere).toStrictEqual({
      ok: true,
      value: { kind: 'task-meta', taskKey, directKrKeys: [] },
    });
    assert(clearedSphere.ok);

    const reassign = {
      initiativeKey,
      sphereTagKey,
      directKrKeys: [secondKrKey, krKey, secondKrKey],
    };
    expect(updateTaskLinks(taskKey, clearedSphere.value, reassign, partial)).toStrictEqual({
      ok: true,
      value: { ...taskMeta, directKrKeys: [krKey, secondKrKey] },
    });
  });

  it('clears a sphere without touching the initiative or reordering an unchanged set of KR', async () => {
    const { updateTaskLinks } = await loadOperations();
    const existing = Object.freeze({
      ...taskMeta,
      directKrKeys: Object.freeze([unavailableKrKey, krKey]),
    });
    const missingTargets = {
      ...partial,
      initiativeKeys: new Set<string>(),
      krKeys: new Set<string>(),
      sphereTagKeys: new Set<string>(),
    };
    expect(
      updateTaskLinks(taskKey, existing, { sphereTagKey: null }, missingTargets),
    ).toStrictEqual({
      ok: true,
      value: { kind: 'task-meta', taskKey, initiativeKey, directKrKeys: existing.directKrKeys },
    });
  });

  it('can add an available KR without revalidating the retained unavailable KR', async () => {
    const { updateTaskLinks } = await loadOperations();
    const changes = { directKrKeys: [unavailableKrKey, secondKrKey, krKey] };
    expect(updateTaskLinks(taskKey, taskMeta, changes, partial)).toStrictEqual({
      ok: true,
      value: { ...taskMeta, directKrKeys: [krKey, secondKrKey, unavailableKrKey] },
    });
  });

  it('requires a known source task when creating metadata', async () => {
    const { updateTaskLinks } = await loadOperations();
    const changes = { directKrKeys: [secondKrKey], sphereTagKey };
    expectFieldError(updateTaskLinks(taskKey, undefined, changes, partial), 'taskKey');
    expect(updateTaskLinks(taskKey, undefined, changes, available)).toStrictEqual({
      ok: true,
      value: { kind: 'task-meta', taskKey, ...changes },
    });
  });

  it.each([
    ['initiativeKey', { initiativeKey: 'initiative:00000000-0000-5000-8000-000000000002' }],
    ['sphereTagKey', { sphereTagKey: 'tag:Missing' }],
    ['directKrKeys', { directKrKeys: [krKey, 'kr:00000000-0000-4000-8000-000000000004'] }],
  ] as const)('rejects a new unavailable %s', async (field, changes) => {
    const { updateTaskLinks } = await loadOperations();
    expectFieldError(updateTaskLinks(taskKey, taskMeta, changes, available), field);
  });
});
