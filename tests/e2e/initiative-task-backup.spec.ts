import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import type { Project, Task } from '@super-productivity/plugin-api';
import {
  committedWrite,
  deviceId,
  draft,
  form,
  load,
  pauseDraft,
  receipt,
  saved,
  status,
} from './save-confirmation.fixtures';
import {
  chooseKrs,
  confirmWrite,
  deleteTask,
  expectBytes,
  expectChoice,
  field,
  findProject,
  findTask,
  initiativeKey,
  keys,
  openRow,
  project,
  projectKey,
  ready,
  reopen,
  restoreDeletedTask,
  save,
  seed,
  seedGoals,
  tag,
  tagKey,
  task,
  taskKey,
  taskMetaKey,
  titles,
  version,
  type Write,
} from './initiative-task.fixtures';
import {
  expect,
  exportBackup,
  importBackup,
  isSyncOps,
  openPluginPanel,
  test,
  type Stand,
  type StandProfile,
} from './stand';

type EntityState<Entity> = { ids: string[]; entities: Record<string, Entity> };
interface Backup {
  data: {
    project: EntityState<Project>;
    task: EntityState<Task>;
    archiveYoung: { task: EntityState<Task> };
    archiveOld: { task: EntityState<Task> };
    pluginUserData: { id: string; data: string }[];
  };
}

async function dump(profile: StandProfile) {
  await profile.page.goto(new URL('/#/config', profile.page.url()).href);
  const file = await exportBackup(profile.page);
  return { file, backup: JSON.parse(await readFile(file, 'utf8')) as Backup };
}

function asFile(backup: Backup) {
  return {
    name: 'synthetic-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  };
}

async function restoreBackup(
  stand: Stand,
  profile: StandProfile,
  file: string | ReturnType<typeof asFile>,
) {
  await profile.page.goto(new URL('/#/config', profile.page.url()).href);
  await importBackup(profile.page, file);
  await reopen(stand, profile);
}

function archiveTask(
  backup: Backup,
  name: 'archiveYoung' | 'archiveOld',
  id: string,
  doneOn: number,
) {
  const active = backup.data.task;
  const archived = backup.data[name].task;
  const { [id]: task, ...remaining } = active.entities;
  if (!task) throw new Error('Expected a native task in the backup');
  expect(task.id).toBe(id);
  archived.ids.push(id);
  archived.entities[id] = { ...task, isDone: true, doneOn };
  active.ids = active.ids.filter((item) => item !== id);
  active.entities = remaining;
  const project = backup.data.project.entities[task.projectId!]!;
  project.taskIds = project.taskIds.filter((item) => item !== id);
  project.backlogTaskIds = project.backlogTaskIds.filter((item) => item !== id);
}

function backupValue(backup: Backup, key: string) {
  const stored = backup.data.pluginUserData.find(({ id }) => id === 'sp-telos:' + key)?.data;
  if (!stored) throw new Error('Missing backup data for ' + key);
  return stored.startsWith('GZ1:')
    ? gunzipSync(Buffer.from(stored.slice(4), 'base64')).toString('utf8')
    : stored;
}

async function archiveContents(profile: StandProfile) {
  return form(profile).evaluate(() => PluginAPI.getArchivedTasks());
}

async function firstPollAfterRotation(profile: StandProfile, key: string, previousId: string) {
  await profile.page.exposeBinding('readCommittedClientId', () => deviceId(profile.page));
  const observation = await form(profile).evaluateHandle(
    (_body, { key, previousId }) => {
      const original = PluginAPI.getSyncedDataSaveState;
      const polls: unknown[] = [];
      const { readCommittedClientId } = window as unknown as {
        readCommittedClientId(): Promise<string | undefined>;
      };
      PluginAPI.getSyncedDataSaveState = async (keys) => {
        const reply = await original(keys);
        const id = keys.includes(key) ? await readCommittedClientId() : undefined;
        if (id && id !== previousId) polls.push(reply.keys[key]);
        return reply;
      };
      return polls;
    },
    { key, previousId },
  );
  return observation;
}

async function checkRevocation(stand: Stand) {
  const connected = await stand.newProfile();
  await stand.connectSync(connected);
  await ready(connected);
  const goals = await seedGoals(connected);
  const taskId = await task(connected, 'Keep the linked draft after import');
  const key = await taskMetaKey(taskId);
  const record = {
    kind: 'task-meta' as const,
    taskKey: taskKey(taskId),
    directKrKeys: [goals.kr[0]!],
  };
  await seed(connected, [{ key, base: 'absent', record }]);
  const author = await openPluginPanel(connected);
  await author.frame
    .getByLabel('Задача', { exact: true })
    .selectOption({ label: 'Keep the linked draft after import' });
  const hold = await pauseDraft(form(author), key, 'put');
  try {
    await chooseKrs(author.frame, [titles.kr[1]!]);
    const previousId = (await deviceId(author.page))!;
    expect(previousId).toBeTruthy();
    const write = await save(author, key, { ...record, directKrKeys: [goals.kr[1]!] });
    await hold.entered();
    const operation = await committedWrite(author, write);
    expect(operation.clientId).toBe(previousId);
    await confirmWrite(author, write);
    expect((await status(form(author), [key])).keys[key]).toEqual(receipt(write.value));
    const polls = await firstPollAfterRotation(author, key, previousId);
    const { file, backup } = await dump(author);
    expect(backupValue(backup, key)).toBe(write.value);
    await importBackup(author.page, file);
    await expect
      .poll(async () => {
        const after = await deviceId(author.page);
        return Boolean(after && after !== previousId);
      })
      .toBe(true);
    await expect
      .poll(async () => (await polls.jsonValue())[0], { timeout: 15_000 })
      .toEqual({ state: 'unknown' });
    await expect(author.frame.getByText(saved)).toHaveCount(0);
    await expect.poll(async () => (await polls.jsonValue()).length).toBeGreaterThanOrEqual(2);
    expect(await polls.jsonValue()).not.toContainEqual(receipt(write.value));
    expect(await keys(author, 'task-meta:')).toEqual([key]);
    await expectBytes(author, [write]);
    expect(version({ key, value: (await load(form(author), key))! }).ver).toBe(version(write).ver);

    await hold.release();
    await expect.poll(async () => (await hold.read()).outcome).toBe('complete');
    expect((await hold.read()).deletes).toBe(0);
    expect(await draft(form(author), key)).toMatchObject({ handoffVer: version(write).ver });
  } finally {
    await hold.release().catch(() => undefined);
  }
}

test('Import a full synthetic backup in an isolated profile', async ({ stand }) => {
  test.setTimeout(240_000);
  const source = await stand.newProfile();
  const reader = await stand.newProfile();
  await ready(source);
  await ready(reader);
  expect(source.context).not.toBe(reader.context);

  const syncRequests: string[] = [];
  reader.context.on('request', (request) => {
    if (isSyncOps(request, 'GET') || isSyncOps(request, 'POST'))
      syncRequests.push(request.method());
  });
  const goals = await seedGoals(source);
  const projectId = await project(source, 'Archived original project');
  const young = await task(source, 'Task from young archive', projectId);
  const old = await task(source, 'Task from old archive', projectId);
  const missingTitle = 'Task with a dangling reference';
  const missing = await task(source, missingTitle);
  const sphere = await tag(source, 'Backup sphere');
  const markKey = await initiativeKey(projectId);
  const oldSnapshot = await dump(source);
  await reopen(stand, source);

  const mark = await seed(source, [
    {
      key: markKey,
      base: 'absent',
      record: {
        kind: 'initiative',
        projectKey: projectKey(projectId),
        krKey: goals.kr[0]!,
        initiativeType: 'regular',
        cadence: 'Monthly',
      },
    },
  ]);
  const links = await seed(
    source,
    await Promise.all(
      [young, old, missing].map(async (id) => ({
        key: await taskMetaKey(id),
        base: 'absent',
        record: {
          kind: 'task-meta' as const,
          taskKey: taskKey(id),
          initiativeKey: markKey,
          sphereTagKey: tagKey(sphere),
          directKrKeys: [goals.kr[1]!],
        },
      })),
    ),
  );
  const allWrites = [...goals.writes, ...mark, ...links];
  await deleteTask(source, missing);
  const synthetic = (await dump(source)).backup;
  synthetic.data.project.entities[projectId]!.isArchived = true;
  archiveTask(synthetic, 'archiveYoung', young, Date.now() - 86_400_000);
  archiveTask(synthetic, 'archiveOld', old, Date.now() - 120 * 86_400_000);

  const writeIds = async (profile: StandProfile, writes: readonly Write[]) => {
    await expectBytes(profile, writes);
    expect(await keys(profile, 'task-meta:')).toEqual(
      links.map(({ key }) => key).sort((a, b) => a.localeCompare(b)),
    );
  };

  await test.step('Export and import complete data while both profiles are disconnected', async () => {
    await restoreBackup(stand, source, asFile(synthetic));
    const { file, backup } = await dump(source);
    expect(backup.data.archiveYoung.task.ids).toEqual([young]);
    expect(backup.data.archiveOld.task.ids).toEqual([old]);
    expect(backup.data.project.entities[projectId]).toMatchObject({
      id: projectId,
      isArchived: true,
    });
    expect(backup.data.task.entities[missing]).toBeUndefined();
    for (const { key, value } of allWrites) expect(backupValue(backup, key)).toBe(value);
    expect(await keys(reader, 'initiative:')).toEqual([]);
    await restoreBackup(stand, reader, file);
    await writeIds(reader, allWrites);
    expect(await findTask(reader, missing)).toBeUndefined();
    expect(syncRequests).toEqual([]);
  });

  await test.step('Resolve archived objects and the dangling reference in the imported view', async () => {
    expect(await findProject(reader, projectId)).toMatchObject({ id: projectId, isArchived: true });
    expect(await archiveContents(reader)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: young, title: 'Task from young archive', projectId }),
        expect.objectContaining({ id: old, title: 'Task from old archive', projectId }),
      ]),
    );
    await openRow(stand, reader, 'Archived original project');
    await expect(reader.frame.getByText(/Архив/).first()).toBeVisible();
    await expectChoice(field(reader.frame, 'KR'), titles.kr[0]!);
    await expect(field(reader.frame, 'Периодичность')).toHaveValue('Monthly');
    for (const title of ['Task from young archive', 'Task from old archive']) {
      await openRow(stand, reader, title);
      await expectChoice(field(reader.frame, 'Прямые KR'), [titles.kr[1]!]);
    }
    await reopen(stand, reader);
    await expect(reader.frame.getByText(/Недоступно/).first()).toBeVisible();
  });

  await test.step('Reject a stored value under a foreign canonical key', async () => {
    const invalid = structuredClone(synthetic);
    const wrongKey = await taskMetaKey('another-original-id');
    const original = invalid.data.pluginUserData.find(
      ({ id }) => id === 'sp-telos:' + links[0]!.key,
    )!;
    invalid.data.pluginUserData.push({ ...original, id: 'sp-telos:' + wrongKey });
    const negative = await stand.newProfile();
    await restoreBackup(stand, negative, asFile(invalid));
    expect(await load(form(negative), wrongKey)).toBe(links[0]!.value);
    await expect(
      negative.frame.getByRole('button', { name: 'Task from young archive', exact: true }),
    ).toHaveCount(1);
    await openRow(stand, negative, 'Task from young archive');
    await expectChoice(field(negative.frame, 'Прямые KR'), [titles.kr[1]!]);
    await expectBytes(negative, allWrites);
  });

  await test.step('Restore the original ID without touching Telos and then import the older state', async () => {
    await reopen(stand, source);
    await restoreDeletedTask(stand, source, missing, missingTitle);
    await expectBytes(source, allWrites);
    const returned = await dump(source);
    await restoreBackup(stand, reader, returned.file);
    await expect
      .poll(() => findTask(reader, missing))
      .toMatchObject({ id: missing, title: missingTitle });
    await openRow(stand, reader, missingTitle);
    await expect(reader.frame.getByText(/Недоступно/)).toHaveCount(0);
    await writeIds(reader, allWrites);
    await restoreBackup(stand, reader, oldSnapshot.file);
    await expectBytes(reader, goals.writes);
    expect(await keys(reader, 'initiative:')).toEqual([]);
    expect(await keys(reader, 'task-meta:')).toEqual([]);
    expect(await archiveContents(reader)).toEqual([]);
    expect(await findProject(reader, projectId)).not.toMatchObject({ isArchived: true });
    for (const id of [young, old, missing])
      expect(await findTask(reader, id)).toMatchObject({ id });
    expect(syncRequests).toEqual([]);
  });

  await test.step('Revoke old confirmation after import rotates client ID', () =>
    checkRevocation(stand));
});
