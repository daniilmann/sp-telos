import { reviseKr } from '../../src/core/goals';
import { isPlan } from '../../src/core/plan';
import { KR_VALUE_PREFIX, MODEL_VERSION } from '../../src/core/records';
import {
  expectBytes,
  field,
  keys,
  ready,
  reopen,
  seed,
  seedGoals,
  titles,
  version,
  type Write,
} from './initiative-task.fixtures';
import {
  annual,
  button,
  committedWrite,
  deviceId,
  draft,
  draftKeys,
  form,
  load,
  makePlan,
  pair,
  pauseDraft,
  planInIframe,
  pull,
  receipt,
  setOffline,
  status,
  sync,
  watchUploads,
} from './save-confirmation.fixtures';
import { expect, exportAndImport, test, type Stand, type StandProfile } from './stand';

const title = titles.kr[0]!;
const otherTitle = titles.kr[1]!;
const reason = 'End of the pilot';
const observation = 'Проверка стала частью еженедельного обзора';
const unconfirmed = 'Сохранение не подтверждено';
const removeInput = 'Снять неподтверждённый ввод';
const input = ({ frame }: StandProfile) => field(frame, 'Фактическое значение');

function verOf(write: Write) {
  const { ver } = version(write);
  if (typeof ver !== 'string') throw new Error('Expected a record version');
  return ver;
}

async function setup(stand: Stand) {
  const { a, b } = await pair(stand);
  await Promise.all([ready(a), ready(b)]);
  const [author, reader] = await Promise.all([deviceId(a.page), deviceId(b.page)]);
  expect([author, reader]).toEqual([expect.any(String), expect.any(String)]);
  expect(reader).not.toBe(author);
  const goals = await seedGoals(a);
  const key = goals.kr[0]!;
  const original = goals.writes.find((write) => write.key === key)!;
  const previous = {
    kind: 'kr',
    status: 'closed',
    outcome: 'not-achieved',
    closureReason: reason,
    objectiveKey: goals.objective,
    statement: 'Initial audit coverage',
    baseline: '30%',
    target: '70%',
    dataSource: 'Pilot audit',
    history: [],
  } as const;
  const [closed] = await seed(a, [{ key, base: verOf(original), record: previous }]);
  const revision = reviseKr(
    previous,
    { ...previous, statement: title, target: '80%' },
    'Expanded pilot scope',
  );
  if (!revision.ok) throw new Error('Invalid fixture KR revision');
  const plan = makePlan([{ key, base: verOf(closed!), record: revision.value }]);
  await planInIframe(form(a), { ...plan, origin: 'kr-revision' });
  const kr = plan.writes[0]!;
  await sync(form(a));
  await pull(b, kr.key, kr.value);
  await Promise.all([reopen(stand, a), reopen(stand, b)]);
  await test.step('Both devices can open the existing closed KR card', async () => {
    await Promise.all([openClosedKr(a), openClosedKr(b)]);
  });
  await test.step('The existing card exposes the new measurement input', async () => {
    for (const profile of [a, b]) {
      await expect(input(profile)).toBeEditable();
    }
  });
  return { a, b, kr };
}

async function openClosedKr(profile: StandProfile) {
  await button(profile.frame, title).click();
  const { frame } = profile;
  await expect(frame.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(button(frame, 'Пересмотреть результат')).toBeEnabled();
  await expect(
    frame.getByText('Закрыто · Не достигнуто. ' + reason, { exact: true }),
  ).toBeVisible();
  for (const [label, value] of [
    ['Исходное значение', '30%'],
    ['Целевое значение', '80%'],
    ['Источник данных', 'Pilot audit'],
  ] as const) {
    await expect(field(frame, label)).toHaveValue(value);
  }
  const history = frame.getByText('История пересмотров', { exact: true });
  await history.click();
  const revision = frame.locator('details').filter({ has: history }).getByRole('listitem');
  await expect(revision).toHaveCount(1);
  for (const text of ['Initial audit coverage', '70%', 'Expanded pilot scope', reason]) {
    await expect(revision.getByText(text, { exact: true })).toBeVisible();
  }
}

async function backToList({ frame }: StandProfile) {
  await button(frame, 'К списку').click();
  await expect(frame.getByRole('heading', { name: annual, exact: true })).toBeVisible();
}

async function observeApply(profile: StandProfile) {
  return profile.frame.owner().evaluateHandle((element) => {
    const iframe = (element as HTMLIFrameElement).contentWindow;
    if (!iframe) throw new Error('Plugin iframe has no window');
    const requests: { id: string; command: unknown }[] = [];
    const replies: { id: string; type: string; result: unknown }[] = [];
    type Payload = {
      type?: string;
      messageId?: string;
      message?: { cmd?: string };
      result?: unknown;
    };
    window.addEventListener('message', (event: MessageEvent<Payload | null>) => {
      if (event.origin !== location.origin || !Object.is(event.source, iframe)) return;
      const { data } = event;
      if (data?.type !== 'PLUGIN_MESSAGE' || data.message?.cmd !== 'apply') return;
      if (typeof data.messageId === 'string')
        requests.push({ id: data.messageId, command: data.message });
    });
    iframe.addEventListener('message', (event: MessageEvent<Payload | null>) => {
      if (event.origin !== location.origin || !Object.is(event.source, window)) return;
      const { data } = event;
      if (data?.type !== 'PLUGIN_MESSAGE_RESPONSE' && data?.type !== 'PLUGIN_MESSAGE_ERROR') return;
      if (typeof data.messageId === 'string') {
        replies.push({ id: data.messageId, type: data.type, result: data.result });
      }
    });
    return { requests, replies };
  });
}

type ApplyLog = Awaited<ReturnType<typeof observeApply>>;

async function submitMeasurement(profile: StandProfile, log: ApplyLog, kr: Write, value: string) {
  const count = (await log.jsonValue()).requests.length;
  await expect(input(profile)).toHaveValue(value);
  await button(profile.frame, 'Внести').click();
  await expect.poll(async () => (await log.jsonValue()).requests.length).toBe(count + 1);
  const { command } = (await log.jsonValue()).requests[count]!;
  expect(command).toMatchObject({
    expectedWipe: 'absent',
    byteCheck: 'allow-absent',
  });
  const { plan } = command as { plan?: unknown };
  if (!isPlan(plan)) throw new Error('Expected a valid measurement plan');
  expect(plan.origin).toBe('manual');
  expect(plan.writes).toHaveLength(1);
  const write = plan.writes[0]!;
  expect(write.key.startsWith(KR_VALUE_PREFIX)).toBe(true);
  expect(write.base).toBe('absent');
  expect(version(write)).toMatchObject({
    v: MODEL_VERSION,
    record: { kind: 'kr-value', krKey: kr.key, value },
  });
  await expect.poll(() => load(form(profile), write.key)).toBe(write.value);
  return { plan, write, operation: await committedWrite(profile, write) };
}

async function expectFacts(profile: StandProfile, facts: readonly Write[]) {
  await expect
    .poll(() => keys(profile, KR_VALUE_PREFIX))
    .toEqual(facts.map(({ key }) => key).sort((left, right) => left.localeCompare(right)));
  await expectBytes(profile, facts);
  const values = facts.map((write) => {
    const { record } = version(write);
    if (!('kind' in record) || record.kind !== 'kr-value') throw new Error('Expected a KR fact');
    return record.value;
  });
  for (const value of new Set(values)) {
    const count = values.filter((text) => text === value).length;
    const rows = profile.frame.getByText(value, { exact: true });
    await expect(rows).toHaveCount(count);
    for (let i = 0; i < count; i++) await expect(rows.nth(i)).toBeVisible();
  }
}

async function onlyFactDraft(profile: StandProfile, except?: string) {
  const readKeys = async () =>
    (await draftKeys(form(profile)))?.filter(
      (key): key is string =>
        typeof key === 'string' && key.startsWith(KR_VALUE_PREFIX) && key !== except,
    );
  await expect.poll(readKeys).toHaveLength(1);
  const key = (await readKeys())![0]!;
  return { key, value: (await draft(form(profile), key))! };
}

test('Record measurements and read them on two devices', async ({ stand }) => {
  const { a, b, kr } = await setup(stand);
  const logA = await observeApply(a);
  const logB = await observeApply(b);
  const uploadsA = watchUploads(a.context);
  const uploadsB = watchUploads(b.context);

  const zero =
    await test.step('Deliver zero to the open card without replacing its draft', async () => {
      await input(b).fill(observation);
      const pending = await onlyFactDraft(b);
      expect(pending.value.fields).toMatchObject({ krKey: kr.key, value: observation });
      expect(await keys(b, KR_VALUE_PREFIX)).toEqual([]);
      await input(a).fill('0');
      const { write, operation } = await submitMeasurement(a, logA, kr, '0');
      await sync(form(a));
      await uploadsA.accepted(operation);
      await pull(b, write.key, write.value);
      await expectFacts(b, [write]);
      await expect(input(b)).toHaveValue(observation);
      expect(await draft(form(b), pending.key)).toEqual(pending.value);
      return write;
    });

  const facts = [zero];
  await test.step('Deliver each independent submission of the same text to the author', async () => {
    for (let i = 0; i < 2; i++) {
      if (i > 0) await input(b).fill(observation);
      const { write, operation } = await submitMeasurement(b, logB, kr, observation);
      expect(facts.map(({ key }) => key)).not.toContain(write.key);
      await sync(form(b));
      await uploadsB.accepted(operation);
      await expect
        .poll(async () => (await status(form(b), [write.key])).keys[write.key])
        .toEqual(receipt(write.value));
      await expect.poll(() => draft(form(b), write.key)).toBeUndefined();
      await pull(a, write.key, write.value);
      facts.push(write);
      await Promise.all([expectFacts(a, facts), expectFacts(b, facts)]);
    }
  });

  await test.step('Reopening shows the three exact facts and the unchanged closed KR', async () => {
    for (const profile of [a, b]) {
      await reopen(stand, profile);
      await openClosedKr(profile);
      await expectFacts(profile, facts);
      await expectBytes(profile, [kr]);
    }
  });
});

function readFactOperationIds(prefix: string) {
  type Row = { op: { id: string; d?: string; ds?: string[]; e?: string } };
  const isFact = ({ op }: Row) =>
    op.e === 'PLUGIN_USER_DATA' && [op.d, ...(op.ds ?? [])].some((id) => id?.startsWith(prefix));
  return new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('SUP_OPS');
    open.onupgradeneeded = () => open.transaction?.abort();
    open.onerror = () => {
      reject(open.error ?? new Error('Could not open the operation journal'));
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('ops', 'readonly');
      const read = tx.objectStore('ops').getAll();
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('Could not read the operation journal'));
      };
      tx.oncomplete = () => {
        db.close();
        const rows = read.result as Row[];
        resolve(rows.filter(isFact).map(({ op }) => op.id));
      };
    };
  });
}

async function waitForUnconfirmed(profile: StandProfile) {
  await expect(profile.frame.getByText(unconfirmed, { exact: true })).toBeVisible({
    timeout: 35_000,
  });
  await expect(button(profile.frame, 'Повторить')).toBeEnabled();
}

test('Keep a visible measurement unconfirmed when its receipt is unavailable', async ({
  stand,
}) => {
  const { a, b, kr } = await setup(stand);
  const uploads = watchUploads(a.context);
  const log = await observeApply(a);
  const online = await setOffline(a);
  const independentText = 'Сверить отчёт по второй площадке';
  const { plan, write, operation, independent } =
    await test.step('Commit the fact offline and close its card with both local drafts retained', async () => {
      try {
        await input(a).fill(observation);
        const submission = await submitMeasurement(a, log, kr, observation);
        expect((await status(form(a), [submission.write.key])).sync).toBe('offline');
        await backToList(a);
        await button(a.frame, otherTitle).click();
        await input(a).fill(independentText);
        await backToList(a);
        const independent = await onlyFactDraft(a, submission.write.key);
        expect(independent.value.fields).toMatchObject({ value: independentText });
        expect(await load(form(b), submission.write.key)).toBeNull();
        return { ...submission, independent };
      } finally {
        await online();
      }
    });

  await test.step('Deliver the exact operation and revoke its receipt by importing the same backup', async () => {
    await sync(form(a));
    await uploads.accepted(operation);
    await pull(b, write.key, write.value);
    await expectFacts(b, [write]);
    await expect
      .poll(async () => (await status(form(a), [write.key])).keys[write.key])
      .toEqual(receipt(write.value));
    expect(await draft(form(a), write.key)).toBeDefined();
    const oldId = await deviceId(a.page);
    expect(oldId).toBe(operation.clientId);
    await a.page.goto(new URL('/#/config', a.page.url()).href);
    await exportAndImport(a.page);
    await expect
      .poll(async () => {
        const id = await deviceId(a.page);
        return Boolean(id && id !== oldId);
      })
      .toBe(true);
    await reopen(stand, a);
    await expectBytes(a, [kr, write]);
    expect((await status(form(a), [write.key])).keys[write.key]).toEqual({ state: 'unknown' });
  });

  await openClosedKr(a);
  await expectFacts(a, [write]);
  await waitForUnconfirmed(a);
  const retryLog = await observeApply(a);
  const journal = (profile: StandProfile) =>
    profile.page.evaluate(readFactOperationIds, 'sp-telos:' + KR_VALUE_PREFIX);
  const journals = () => Promise.all([journal(a), journal(b)]);
  const before = await journals();
  expect(before[1]).toEqual([operation.id]);

  await test.step('Retry the same plan, with a real zero-write reply and the draft still present', async () => {
    await expect.poll(async () => (await draft(form(a), write.key))?.baseVer).toBe(verOf(write));
    await button(a.frame, 'Повторить').click();
    await expect.poll(async () => (await retryLog.jsonValue()).requests.length).toBe(1);
    const { id, command } = (await retryLog.jsonValue()).requests[0]!;
    expect(command).toMatchObject({
      plan,
      forceSync: true,
      byteCheck: 'require-exact',
      expectedWipe: 'absent',
    });
    await expect
      .poll(async () => (await retryLog.jsonValue()).replies.find((reply) => reply.id === id))
      .toEqual({
        id,
        type: 'PLUGIN_MESSAGE_RESPONSE',
        result: { total: 1, transferred: 0, writes: [write] },
      });
    await waitForUnconfirmed(a);
    expect((await status(form(a), [write.key])).keys[write.key]).toEqual({ state: 'unknown' });
    await expect(input(a)).toHaveValue(observation);
    expect(await draft(form(a), write.key)).toBeDefined();
    await expectFacts(a, [write]);
    expect(await journals()).toEqual(before);
  });

  await test.step('Explicit removal waits for local deletion and keeps the fact and the other draft', async () => {
    const deletion = await pauseDraft(form(a), write.key, 'delete');
    try {
      await button(a.frame, removeInput).click();
      await deletion.entered();
      expect((await deletion.read()).outcome).toBe('');
      await expect(input(a)).toHaveValue(observation);
    } finally {
      await deletion.release();
    }
    await expect.poll(deletion.read).toMatchObject({ outcome: 'complete', deletes: 1 });
    await expect.poll(() => draft(form(a), write.key)).toBeUndefined();
    expect((await retryLog.jsonValue()).requests).toHaveLength(1);
    expect(await journals()).toEqual(before);
    await reopen(stand, a);
    await openClosedKr(a);
    await expect(input(a)).toHaveValue('');
    await expect(a.frame.getByText(unconfirmed, { exact: true })).toHaveCount(0);
    await expectFacts(a, [write]);
    await expectFacts(b, [write]);
    await expectBytes(a, [kr]);
    expect(await draft(form(a), independent.key)).toEqual(independent.value);
    await backToList(a);
    await button(a.frame, otherTitle).click();
    await expect(input(a)).toHaveValue(independentText);
  });
});
