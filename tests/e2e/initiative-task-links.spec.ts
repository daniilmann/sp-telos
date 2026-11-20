import { button, form, load } from './save-confirmation.fixtures';
import {
  choose,
  chooseKrs,
  expectBytes,
  expectChoice,
  field,
  findProject,
  findTag,
  findTask,
  inboxId,
  initiativeKey,
  keys,
  linkedPicker,
  openLinked,
  openRow,
  project,
  projectKey,
  ready,
  save,
  seedGoals,
  selectInitiative,
  tag,
  tagKey,
  task,
  taskKey,
  taskMetaKey,
  titles,
  updateTask,
  version,
} from './initiative-task.fixtures';
import { expect, test } from './stand';

test('Mark a project and reopen the same initiative', async ({ stand }) => {
  const profile = await stand.newProfile();
  await ready(profile);
  await linkedPicker(profile, 'Проект');
  const goals = await seedGoals(profile);
  const projectId = await project(profile, 'Product research');
  const taskId = await task(profile, 'Interview users', projectId);
  const originalProject = await findProject(profile, projectId);
  const originalTask = await findTask(profile, taskId);
  expect(originalProject?.taskIds).toContain(taskId);

  const key = await initiativeKey(projectId);
  const regular = {
    kind: 'initiative' as const,
    projectKey: projectKey(projectId),
    krKey: goals.kr[0]!,
    initiativeType: 'regular' as const,
    cadence: 'Every two weeks',
  };
  const first = await test.step('Mark the existing project as a regular initiative', async () => {
    await openLinked(stand, profile, 'Проект', 'Product research');
    await selectInitiative(profile, { kr: titles.kr[0]!, cadence: regular.cadence });
    return save(profile, key, regular);
  });
  await test.step('Select the same project and change only its KR', async () => {
    await openLinked(stand, profile, 'Проект', 'Product research');
    await expectChoice(field(profile.frame, 'KR'), titles.kr[0]!);
    await expectChoice(field(profile.frame, 'Вид'), 'Регулярная');
    await expect(field(profile.frame, 'Периодичность')).toHaveValue(regular.cadence);
    await choose(field(profile.frame, 'KR'), titles.kr[1]!);
    const edited = await save(profile, key, { ...regular, krKey: goals.kr[1]! });
    expect(edited.base).toBe(version(first).ver);
    await expect.poll(() => keys(profile, 'initiative:')).toEqual([key]);
    expect(await findProject(profile, projectId)).toEqual(originalProject);
    expect(await findTask(profile, taskId)).toEqual(originalTask);
    await expectBytes(profile, goals.writes);
  });
});

test('Move a task or change its initiative without rewriting direct KR', async ({ stand }) => {
  test.setTimeout(150_000);
  const profile = await stand.newProfile();
  await ready(profile);
  const goals = await seedGoals(profile);
  const firstProject = await project(profile, 'Research');
  const secondProject = await project(profile, 'Delivery');
  const taskId = await task(profile, 'Ship a survey', firstProject);
  const sphere = await tag(profile, 'Community');
  const taskRecord = {
    kind: 'task-meta' as const,
    taskKey: taskKey(taskId),
    sphereTagKey: tagKey(sphere),
    initiativeKey: await initiativeKey(firstProject),
    directKrKeys: [goals.kr[2]!, goals.kr[3]!],
  };
  const secondKey = await initiativeKey(secondProject);
  const secondRecord = {
    kind: 'initiative' as const,
    projectKey: projectKey(secondProject),
    initiativeType: 'one-off' as const,
    krKey: goals.kr[1]!,
  };

  await openLinked(stand, profile, 'Проект', 'Research');
  await selectInitiative(profile, { kr: titles.kr[0]! });
  const first = await save(profile, taskRecord.initiativeKey, {
    ...secondRecord,
    projectKey: projectKey(firstProject),
    krKey: goals.kr[0]!,
  });
  await openLinked(stand, profile, 'Проект', 'Delivery');
  await selectInitiative(profile, { kr: titles.kr[1]! });
  await save(profile, secondKey, secondRecord);

  const key = await taskMetaKey(taskId);
  await openLinked(stand, profile, 'Задача', 'Ship a survey');
  await choose(field(profile.frame, 'Инициатива'), 'Research');
  await choose(field(profile.frame, 'Сфера'), 'Community');
  await chooseKrs(profile.frame, [titles.kr[2]!, titles.kr[3]!]);
  const initial = await save(profile, key, taskRecord);

  for (const destination of [secondProject, inboxId]) {
    await test.step(
      'Move the native task to ' + (destination === inboxId ? 'Inbox' : 'Delivery'),
      async () => {
        await updateTask(profile, taskId, { projectId: destination });
        await expect
          .poll(async () => (await findProject(profile, destination))?.taskIds)
          .toContain(taskId);
        await expectBytes(profile, [initial]);
        await openLinked(stand, profile, 'Задача', 'Ship a survey');
        await expectChoice(field(profile.frame, 'Инициатива'), 'Research');
        await expectChoice(field(profile.frame, 'Сфера'), 'Community');
        await expectChoice(field(profile.frame, 'Прямые KR'), [titles.kr[2]!, titles.kr[3]!]);
      },
    );
  }

  await choose(field(profile.frame, 'Инициатива'), 'Delivery');
  const edited = await save(profile, key, { ...taskRecord, initiativeKey: secondKey });
  await openLinked(stand, profile, 'Проект', 'Delivery');
  await choose(field(profile.frame, 'KR'), titles.kr[0]!);
  await save(profile, secondKey, { ...secondRecord, krKey: goals.kr[0]! });

  await expectBytes(profile, [first, edited, ...goals.writes]);
  await openLinked(stand, profile, 'Задача', 'Ship a survey');
  await expectChoice(field(profile.frame, 'Инициатива'), 'Delivery');
  await expectChoice(field(profile.frame, 'Сфера'), 'Community');
  await expectChoice(field(profile.frame, 'Прямые KR'), [titles.kr[2]!, titles.kr[3]!]);
  expect(await findTask(profile, taskId)).toMatchObject({ id: taskId, projectId: inboxId });
});

test('Resolve renamed base objects by their original IDs', async ({ stand }) => {
  test.setTimeout(180_000);
  const profile = await stand.newProfile();
  await ready(profile);
  const goals = await seedGoals(profile);
  const projectId = await project(profile, 'Old project');
  const taskId = await task(profile, 'Old task', projectId);
  const firstTag = await tag(profile, 'Old sphere');
  const secondTag = await tag(profile, 'New sphere choice');
  const nativeTag = await tag(profile, 'Native task tag');
  const year = {
    kind: 'annual-goal' as const,
    statement: titles.annual,
    status: 'active' as const,
  };
  const objective = {
    kind: 'objective' as const,
    statement: titles.objective,
    status: 'active' as const,
    annualGoalKey: goals.annual,
    quarter: 'Q2',
  };

  await openRow(stand, profile, titles.annual);
  const sphere = field(profile.frame, 'Сфера');
  await expect(sphere, 'The existing annual-goal form exposes the Sphere picker').toBeVisible();
  const linkedKey = await initiativeKey(projectId);
  const taskRecord = {
    kind: 'task-meta' as const,
    taskKey: taskKey(taskId),
    initiativeKey: linkedKey,
    directKrKeys: [goals.kr[2]!, goals.kr[3]!],
  };
  await openLinked(stand, profile, 'Проект', 'Old project');
  await selectInitiative(profile, { kr: titles.kr[0]! });
  const initiative = await save(profile, linkedKey, {
    kind: 'initiative',
    projectKey: projectKey(projectId),
    krKey: goals.kr[0]!,
    initiativeType: 'one-off',
  });
  const taskMeta = await taskMetaKey(taskId);
  await openLinked(stand, profile, 'Задача', 'Old task');
  await choose(field(profile.frame, 'Инициатива'), 'Old project');
  await chooseKrs(profile.frame, [titles.kr[2]!, titles.kr[3]!]);
  await save(profile, taskMeta, taskRecord);

  const owners = [
    { key: goals.annual, record: year, open: () => openRow(stand, profile, titles.annual) },
    {
      key: goals.objective,
      record: objective,
      open: () => openRow(stand, profile, titles.objective),
    },
    {
      key: taskMeta,
      record: taskRecord,
      open: () => openLinked(stand, profile, 'Задача', 'Old task'),
    },
  ];
  const beforeRename =
    await test.step('Assign, change and clear the sphere on all three records', async () => {
      const writes = [];
      for (const owner of owners) {
        for (const choice of [
          { label: 'Old sphere', id: firstTag },
          { label: 'New sphere choice', id: secondTag },
        ]) {
          await owner.open();
          await choose(sphere, choice.label);
          await save(profile, owner.key, { ...owner.record, sphereTagKey: tagKey(choice.id) });
        }
        await owner.open();
        await sphere.selectOption({ value: '' });
        const cleared = await save(profile, owner.key, owner.record);
        expect(version(cleared).record).not.toHaveProperty('sphereTagKey');
        await owner.open();
        await choose(sphere, 'Old sphere');
        writes.push(
          await save(profile, owner.key, { ...owner.record, sphereTagKey: tagKey(firstTag) }),
        );
      }
      expect((await findTask(profile, taskId))?.tagIds).not.toContain(firstTag);
      await updateTask(profile, taskId, { tagIds: [nativeTag] });
      await expectBytes(profile, writes);
      return [initiative, ...writes];
    });

  await test.step('Rename the three base objects and resolve their original IDs', async () => {
    await updateTask(profile, taskId, { title: 'Renamed task' });
    await form(profile).evaluate(
      async (_body, { projectId, firstTag }) => {
        await PluginAPI.updateProject(projectId, { title: 'Renamed project' });
        await PluginAPI.updateTag(firstTag, { title: 'Renamed sphere' });
      },
      { projectId, firstTag },
    );
    await expect
      .poll(() => findProject(profile, projectId))
      .toMatchObject({ id: projectId, title: 'Renamed project' });
    await expect
      .poll(() => findTag(profile, firstTag))
      .toMatchObject({ id: firstTag, title: 'Renamed sphere' });
    await openRow(stand, profile, titles.annual);
    await expectChoice(sphere, 'Renamed sphere');
    await openRow(stand, profile, titles.objective);
    await expectChoice(sphere, 'Renamed sphere');
    await openLinked(stand, profile, 'Задача', 'Renamed task');
    await expectChoice(sphere, 'Renamed sphere');
    await expectChoice(field(profile.frame, 'Инициатива'), 'Renamed project');
    await expectChoice(field(profile.frame, 'Прямые KR'), [titles.kr[2]!, titles.kr[3]!]);
    await openLinked(stand, profile, 'Проект', 'Renamed project');
    await expectChoice(field(profile.frame, 'KR'), titles.kr[0]!);
    await expectBytes(profile, beforeRename);
    expect((await findTask(profile, taskId))?.tagIds).toEqual([nativeTag]);
    expect(await load(form(profile), taskMeta)).not.toBeNull();
    await expect(button(profile.frame, 'Сохранить')).toBeDisabled();
  });
});
