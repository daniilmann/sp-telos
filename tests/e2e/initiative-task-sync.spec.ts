import {
  button,
  committedWrite,
  deviceId,
  form,
  load,
  pair,
  pull,
  saved,
  setOffline,
  status,
  sync,
  watchDownloads,
  watchUploads,
} from './save-confirmation.fixtures';
import {
  choose,
  chooseKrs,
  confirmWrite,
  deleteTask,
  expectBytes,
  expectChoice,
  field,
  findTask,
  initiativeKey,
  keys,
  openLinked,
  pickLinked,
  project,
  projectKey,
  ready,
  repeatInstances,
  reopen,
  restoreDeletedTask,
  save,
  seedGoals,
  selectInitiative,
  startDailyRepeat,
  tag,
  tagKey,
  task,
  taskKey,
  taskMetaKey,
  titles,
  updateTask,
  version,
  type Write,
} from './initiative-task.fixtures';
import { expect, test, type StandProfile } from './stand';

type NativeAction = 'HA' | 'HD' | 'HR';

function readNativeOperation({ taskId, action }: { taskId: string; action: NativeAction }) {
  return new Promise<{ id: string; clientId: string } | undefined>((resolve, reject) => {
    const open = indexedDB.open('SUP_OPS');
    open.onerror = () => {
      reject(open.error ?? new Error('Could not read the operation journal'));
    };
    open.onupgradeneeded = () => {
      open.transaction?.abort();
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('ops', 'readonly');
      const request = tx.objectStore('ops').getAll();
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('Operation journal read aborted'));
      };
      tx.oncomplete = () => {
        db.close();
        const rows = request.result as {
          source: string;
          op: { id: string; a: string; d?: string; ds?: string[]; e: string; c: string };
        }[];
        const row = rows.find(
          ({ source, op }) =>
            source === 'local' &&
            op.e === 'TASK' &&
            op.a === action &&
            (op.d === taskId || op.ds?.includes(taskId)),
        );
        resolve(row && { id: row.op.id, clientId: row.op.c });
      };
    };
  });
}

async function nativeOperation(profile: StandProfile, taskId: string, action: NativeAction) {
  const read = () => profile.page.evaluate(readNativeOperation, { taskId, action });
  await expect
    .poll(read, { message: 'The native operation reached the local journal' })
    .toBeDefined();
  return (await read())!;
}

function observeDelivery(writer: StandProfile, reader: StandProfile) {
  const uploads = watchUploads(writer.context);
  const downloaded = watchDownloads(reader.page);
  return async (operation: { id: string; clientId: string }) => {
    await sync(form(writer));
    const sequence = await uploads.accepted(operation);
    await sync(form(reader));
    await downloaded({ ...operation, isPayloadEncrypted: true }, sequence);
  };
}

async function pullAll(reader: StandProfile, writes: readonly Write[]) {
  await expect(async () => {
    await sync(form(reader));
    await expectBytes(reader, writes);
  }).toPass({ timeout: 25_000 });
}

test('Resolve either delivery order and return of the original ID', async ({ stand }) => {
  const { a, b } = await pair(stand);
  await ready(a);
  await ready(b);
  const deliver = observeDelivery(a, b);
  const goals = await seedGoals(a);
  const projectId = await project(a, 'Delivery experiment');
  const taskFirstTitle = 'Arrives before its metadata';
  const taskFirst = await task(a, taskFirstTitle, projectId);
  const taskFirstKey = await taskMetaKey(taskFirst);
  await test.step('Deliver the native task before its metadata', async () => {
    await deliver(await nativeOperation(a, taskFirst, 'HA'));
    await expect
      .poll(() => findTask(b, taskFirst))
      .toMatchObject({ id: taskFirst, title: taskFirstTitle });
    expect(await load(form(b), taskFirstKey)).toBeNull();
  });

  const first = await test.step('Save and deliver metadata in a separate cycle', async () => {
    await openLinked(stand, a, 'Задача', taskFirstTitle);
    await chooseKrs(a.frame, [titles.kr[0]!]);
    const write = await save(a, taskFirstKey, {
      kind: 'task-meta',
      taskKey: taskKey(taskFirst),
      directKrKeys: [goals.kr[0]!],
    });
    await deliver(await committedWrite(a, write));
    await pull(b, write.key, write.value);
    await openLinked(stand, b, 'Задача', taskFirstTitle);
    await expectChoice(field(b.frame, 'Прямые KR'), [titles.kr[0]!]);
    return write;
  });

  const taskLaterTitle = 'Returns under its original ID';
  const { taskLater, second } =
    await test.step('Publish metadata for a deleted task before the receiver sees the original ID', async () => {
      const onlineReader = await setOffline(b);
      try {
        const uploads = watchUploads(a.context);
        const taskLater = await task(a, taskLaterTitle, projectId);
        const created = await nativeOperation(a, taskLater, 'HA');
        await sync(form(a));
        await uploads.accepted(created);
        const taskLaterKey = await taskMetaKey(taskLater);
        await openLinked(stand, a, 'Задача', taskLaterTitle);
        const onlineWriter = await setOffline(a);
        let second: Write;
        try {
          await chooseKrs(a.frame, [titles.kr[1]!]);
          second = await save(a, taskLaterKey, {
            kind: 'task-meta',
            taskKey: taskKey(taskLater),
            directKrKeys: [goals.kr[1]!],
          });
          await deleteTask(a, taskLater);
        } finally {
          await onlineWriter();
        }
        await sync(form(a));
        await uploads.accepted(await nativeOperation(a, taskLater, 'HD'));
        await uploads.accepted(await committedWrite(a, second));
        expect(await findTask(b, taskLater)).toBeUndefined();
        expect(await load(form(b), second.key)).toBeNull();
        return { taskLater, second };
      } finally {
        await onlineReader();
      }
    });

  await test.step('Resolve the delivered metadata while its native target is absent', async () => {
    await deliver(await nativeOperation(a, taskLater, 'HD'));
    await deliver(await committedWrite(a, second));
    await pull(b, second.key, second.value);
    expect(await findTask(b, taskLater)).toBeUndefined();
    expect(
      await form(b).evaluate(
        async (_body, id) => (await PluginAPI.getArchivedTasks()).some((item) => item.id === id),
        taskLater,
      ),
    ).toBe(false);
    await reopen(stand, b);
    await expect(b.frame.getByText(/Недоступно/).first()).toBeVisible();
    await expectBytes(b, [first, second]);
  });

  await test.step('Restore the deleted original ID and deliver the native operation alone', async () => {
    await restoreDeletedTask(stand, a, taskLater, taskLaterTitle);
    await deliver(await nativeOperation(a, taskLater, 'HR'));
    await expect
      .poll(() => findTask(b, taskLater))
      .toMatchObject({ id: taskLater, title: taskLaterTitle });
    await openLinked(stand, b, 'Задача', taskLaterTitle);
    await expect(b.frame.getByText(/Недоступно/)).toHaveCount(0);
    await expectChoice(field(b.frame, 'Прямые KR'), [titles.kr[1]!]);
    await expectBytes(b, [first, second]);
  });
});

test('Converge concurrent changes by whole key', async ({ stand }) => {
  const { a, b } = await pair(stand);
  await ready(a);
  await ready(b);
  const goals = await seedGoals(a);
  const projectId = await project(a, 'Shared project');
  const shared = await task(a, 'Shared task', projectId);
  const onlyA = await task(a, 'Independent A', projectId);
  const onlyB = await task(a, 'Independent B', projectId);
  const tagA = await tag(a, 'Sphere A');
  const tagB = await tag(a, 'Sphere B');
  const markKey = await initiativeKey(projectId);
  const sharedKey = await taskMetaKey(shared);
  const mark = {
    kind: 'initiative' as const,
    projectKey: projectKey(projectId),
    initiativeType: 'one-off' as const,
    krKey: goals.kr[0]!,
  };
  await openLinked(stand, a, 'Проект', 'Shared project');
  await selectInitiative(a, { kr: titles.kr[0]! });
  const originalMark = await save(a, markKey, mark);
  const sharedRecord = {
    kind: 'task-meta' as const,
    taskKey: taskKey(shared),
    initiativeKey: markKey,
  };
  await openLinked(stand, a, 'Задача', 'Shared task');
  await choose(field(a.frame, 'Инициатива'), 'Shared project');
  const originalShared = await save(a, sharedKey, sharedRecord);
  await sync(form(a));
  await pullAll(b, [originalMark, originalShared]);
  await expect.poll(() => findTask(b, onlyB)).toMatchObject({ id: onlyB });

  const edit = async (
    profile: StandProfile,
    index: number,
    privateId: string,
    sphereId: string,
    suffix: string,
  ) => {
    await choose(field(profile.frame, 'KR'), titles.kr[index]!);
    const initiative = await save(profile, markKey, { ...mark, krKey: goals.kr[index]! });
    await button(profile.frame, 'К списку').click();
    await pickLinked(profile, 'Задача', 'Shared task');
    await choose(field(profile.frame, 'Сфера'), 'Sphere ' + suffix);
    await chooseKrs(profile.frame, [titles.kr[index + 1]!]);
    const metadata = await save(profile, sharedKey, {
      ...sharedRecord,
      sphereTagKey: tagKey(sphereId),
      directKrKeys: [goals.kr[index + 1]!],
    });
    await button(profile.frame, 'К списку').click();
    await pickLinked(profile, 'Задача', 'Independent ' + suffix);
    await chooseKrs(profile.frame, [titles.kr[index]!]);
    const privateWrite = await save(profile, await taskMetaKey(privateId), {
      kind: 'task-meta',
      taskKey: taskKey(privateId),
      directKrKeys: [goals.kr[index]!],
    });
    return { initiative, metadata, privateWrite };
  };

  await openLinked(stand, a, 'Проект', 'Shared project');
  await openLinked(stand, b, 'Проект', 'Shared project');
  const uploadsA = watchUploads(a.context);
  const uploadsB = watchUploads(b.context);
  const onlineA = await setOffline(a);
  const onlineB = await setOffline(b);
  const sentBefore = [uploadsA.count(), uploadsB.count()];
  let left: Awaited<ReturnType<typeof edit>>;
  let right: Awaited<ReturnType<typeof edit>>;
  try {
    [left, right] = await Promise.all([edit(a, 1, onlyA, tagA, 'A'), edit(b, 2, onlyB, tagB, 'B')]);
    for (const edit of ['initiative', 'metadata'] as const) {
      expect(left[edit].base).toBe(right[edit].base);
      expect(version(left[edit]).ver).not.toBe(version(right[edit]).ver);
    }
    expect([uploadsA.count(), uploadsB.count()]).toEqual(sentBefore);
    expect(await load(form(a), right.privateWrite.key)).toBeNull();
    expect(await load(form(b), left.privateWrite.key)).toBeNull();
  } finally {
    await Promise.all([onlineA(), onlineB()]);
  }

  await test.step('Synchronize the competing whole values and the two independent keys', async () => {
    const opA = await committedWrite(a, left.privateWrite);
    const opB = await committedWrite(b, right.privateWrite);
    await Promise.all([sync(form(a)), sync(form(b))]);
    await Promise.all([uploadsA.accepted(opA), uploadsB.accepted(opB)]);
    await expect(async () => {
      await sync(form(a));
      await sync(form(b));
      for (const [key, allowed] of [
        [markKey, [left.initiative.value, right.initiative.value]],
        [sharedKey, [left.metadata.value, right.metadata.value]],
      ] as const) {
        const onA = await load(form(a), key);
        expect(allowed).toContain(onA);
        expect(await load(form(b), key)).toBe(onA);
      }
      const independent = [left.privateWrite, right.privateWrite];
      for (const profile of [a, b]) {
        await expectBytes(profile, independent);
        expect(await keys(profile, 'initiative:')).toEqual([markKey]);
        expect(await keys(profile, 'task-meta:')).toEqual(
          [sharedKey, ...independent.map((write) => write.key)].sort((a, b) => a.localeCompare(b)),
        );
      }
    }).toPass({ timeout: 35_000 });
  });
});

test('Confirm on the writer and read independently on a second client', async ({ stand }) => {
  const { a, b } = await pair(stand);
  await ready(a);
  await ready(b);
  expect(await deviceId(a.page)).toBeTruthy();
  expect(await deviceId(a.page)).not.toBe(await deviceId(b.page));
  const deliver = observeDelivery(a, b);
  const goals = await seedGoals(a);
  const projectId = await project(a, 'Repeat initiative');
  const markKey = await initiativeKey(projectId);
  const mark = {
    kind: 'initiative' as const,
    projectKey: projectKey(projectId),
    initiativeType: 'one-off' as const,
    krKey: goals.kr[0]!,
  };

  const publish = async (write: Write) => {
    await test.step('Check the writer receipt and independently read the same bytes on the receiver', async () => {
      const local = await committedWrite(a, write);
      expect(local.clientId).toBe(await deviceId(a.page));
      await confirmWrite(a, write);
      await deliver(local);
      await pull(b, write.key, write.value);
      await expectBytes(b, [write]);
    });
  };

  await test.step('Link one instance of a native repeat manually', async () => {
    const repeatTitle = 'Daily customer check';
    const repeat = await startDailyRepeat(stand, a, repeatTitle);
    const instance = await repeat.next([repeat.original]);
    const instances = await repeatInstances(a, repeat.repeatCfgId);
    expect(instances.map(({ id }) => id).sort((a, b) => a.localeCompare(b))).toEqual(
      [repeat.original, instance.id].sort((a, b) => a.localeCompare(b)),
    );
    expect(instances.map(({ title }) => title)).toEqual([repeatTitle, repeatTitle]);
    const before = await Promise.all(instances.map(({ id }) => taskMetaKey(id)));
    for (const key of before) expect(await load(form(a), key)).toBeNull();

    await openLinked(stand, a, 'Проект', 'Repeat initiative');
    await selectInitiative(a, { kr: titles.kr[0]! });
    const marked = await save(a, markKey, mark);
    await publish(marked);

    const renamed = 'Selected customer check';
    await updateTask(a, instance.id, { title: renamed });
    await openLinked(stand, a, 'Задача', renamed);
    await choose(field(a.frame, 'Инициатива'), 'Repeat initiative');
    await chooseKrs(a.frame, [titles.kr[2]!, titles.kr[3]!]);
    const key = await taskMetaKey(instance.id);
    const links = {
      kind: 'task-meta' as const,
      taskKey: taskKey(instance.id),
      initiativeKey: markKey,
      directKrKeys: [goals.kr[2]!, goals.kr[3]!],
    };
    const assigned = await save(a, key, links);
    await publish(assigned);
    await expect
      .poll(() => findTask(b, instance.id))
      .toMatchObject({ id: instance.id, title: renamed });

    await updateTask(a, instance.id, { isDone: true });
    const next = await repeat.next(instances.map(({ id }) => id));
    const nextKey = await taskMetaKey(next.id);
    expect(await load(form(a), nextKey)).toBeNull();
    expect(await load(form(a), await taskMetaKey(repeat.original))).toBeNull();
    await sync(form(a));
    await expect(async () => {
      await sync(form(b));
      expect(await findTask(b, next.id)).toMatchObject({
        id: next.id,
        title: repeatTitle,
        repeatCfgId: repeat.repeatCfgId,
      });
    }).toPass({ timeout: 25_000 });
    expect(await load(form(b), nextKey)).toBeNull();
    await expectBytes(b, [marked, assigned]);

    await openLinked(stand, a, 'Задача', renamed);
    const online = await setOffline(a);
    try {
      await chooseKrs(a.frame, [titles.kr[1]!, titles.kr[3]!]);
      const offline = await save(a, key, { ...links, directKrKeys: [goals.kr[1]!, goals.kr[3]!] });
      expect((await status(form(a), [key])).keys[key]?.state).not.toBe('saved');
      await expect(a.frame.getByText(saved)).toHaveCount(0);
      expect(version(offline).ver).not.toBe(version(assigned).ver);
      await expectBytes(b, [assigned]);
    } finally {
      await online();
    }
  });
});
