import { randomUUID } from 'node:crypto';
import { applyPlan } from '../../src/core/plan';
import { decodeRecord } from '../../src/core/records';
import {
  blockBackgroundSync,
  button,
  committedWrite,
  confirm,
  create,
  deviceId,
  digest,
  draft,
  form,
  load,
  makePlan,
  pair,
  pauseDraft,
  planInIframe,
  pull,
  receipt,
  saved,
  setOffline,
  snapshot,
  statement,
  status,
  submit,
  sync,
  watchUploads,
} from './save-confirmation.fixtures';
import { expect, exportAndImport, openPluginPanel, test, type StandProfile } from './stand';

async function checkForeignKey(profile: StandProfile, own: { key: string; value: string }) {
  const page = profile.page;
  const origin = new URL(page.url()).origin;
  const key = 'other:' + randomUUID();
  const value = '\uFEFF{ "text": "e\u0301" }\n';
  await page.goto(origin + '/#/config');
  await page.locator('mat-tab-header .mat-mdc-tab:has(mat-icon:has-text("extension"))').click();
  const toggle = page
    .locator('plugin-management mat-card')
    .filter({ hasText: 'Doc Mode' })
    .getByRole('switch');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.goto(origin + '/#/plugins/doc-mode/index');
  const other = page.frameLocator('plugin-index iframe[data-plugin-id="doc-mode"]').locator('body');
  await other.evaluate((_body, data) => PluginAPI.persistDataSynced(data.value, data.key), {
    key,
    value,
  });
  await expect(async () => {
    await sync(other);
    expect((await status(other, [key])).keys).toEqual({ [key]: receipt(value) });
  }).toPass({ timeout: 20_000 });
  await page.goto(origin + '/#/config');
  await page.goto(origin + '/#/plugins/sp-telos/index');
  expect(await load(form(profile), key)).toBeNull();
  expect((await status(form(profile), [own.key, key])).keys).toEqual({
    [own.key]: receipt(own.value),
    [key]: { state: 'unknown' },
  });
}

test('server acknowledgement is visible in the form and data arrives on a second client', async ({
  stand,
}) => {
  const { a, b } = await pair(stand);
  const initial = await snapshot(form(a));
  expect(initial).toEqual({ entries: {} });
  const first = await create(a, 'Клиенты — ' + 'e\u0301'.repeat(900));
  await committedWrite(a, first.key, first.value);
  await confirm(a, first);
  const next = await submit(a, 'Клиенты — ' + 'é'.repeat(900));
  await committedWrite(a, next.key, next.value);
  await confirm(a, next);
  const expected = applyPlan(applyPlan(initial, first.plan), next.plan);
  expect(expected.entries).toEqual({ [next.key]: next.value });
  expect(await snapshot(form(a))).toEqual(expected);
  await pull(b, next.key, next.value);
  expect(await snapshot(form(b))).toEqual(expected);
  await stand.openPlugin(b.page);
  await expect(button(b.frame, 'Клиенты — ' + 'é'.repeat(900))).toBeVisible();
  await checkForeignKey(a, next);
});

test('offline input survives closing the form and retry obtains a new acknowledgement', async ({
  stand,
}) => {
  const { a, b } = await pair(stand);
  const first = await create(a, 'Confirmed baseline');
  await confirm(a, first);
  await pull(b, first.key, first.value);
  const reconnect = await setOffline(a);
  const offline = await submit(a, 'Offline value');
  await committedWrite(a, offline.key, offline.value);
  const retry = (profile: StandProfile) => button(profile.frame, 'Повторить');
  await expect(retry(a)).toBeVisible();
  expect((await status(form(a), [offline.key])).sync).toBe('offline');
  expect(await load(form(b), first.key)).toBe(first.value);

  const previousInput = 'Committed offline draft';
  const newestInput = 'Latest offline input';
  await statement(a.frame).fill(previousInput);
  await expect
    .poll(() => draft(form(a), offline.key))
    .toMatchObject({
      fields: { statement: previousInput },
    });
  await statement(a.frame).fill(newestInput);
  await a.page.close();

  const page = await a.context.newPage();
  await blockBackgroundSync(page);
  const reopened = { ...a, page, frame: await stand.openPlugin(page) };
  const persisted = await draft(form(reopened), offline.key);
  const restoredInput = persisted?.fields.statement;
  if (restoredInput !== previousInput && restoredInput !== newestInput)
    throw new Error('The last completed offline draft did not survive closing the view');
  await button(reopened.frame, 'Offline value').click();
  await expect(statement(reopened.frame)).toHaveValue(restoredInput);
  const restored = await submit(reopened, restoredInput);
  await committedWrite(reopened, restored.key, restored.value);
  await expect(retry(reopened)).toBeVisible();
  const uploaded = watchUploads(page);
  await test.step('Restore navigator online and real SuperSync health', () => reconnect(page));
  const retried = await test.step('Click Retry with background sync held', () =>
    submit(reopened, '', 'Повторить'));
  expect(retried.key).toBe(offline.key);
  expect(retried.value).not.toBe(restored.value);
  const before = decodeRecord(restored.key, restored.value);
  const after = decodeRecord(retried.key, retried.value);
  if (!before.ok || !after.ok) throw new Error('Expected valid retry records');
  expect(after.value.ver).not.toBe(before.value.ver);
  expect(after.value).toMatchObject({ statement: restoredInput });
  const operation = await committedWrite(reopened, retried.key, retried.value);
  await test.step(
    'Match the retry upload and its SuperSync acknowledgement',
    () => uploaded(operation),
    { timeout: 20_000 },
  );
  await confirm(reopened, retried, false);
  await pull(b, retried.key, retried.value);
});

test('concurrent writes leave one intact value and history', async ({ stand }) => {
  const { a, b } = await pair(stand);
  const year = 'annual-goal:' + randomUUID();
  const objective = 'objective:' + randomUUID();
  const key = 'kr:' + randomUUID();
  const original = {
    kind: 'kr',
    status: 'active',
    statement: 'Retention',
    baseline: '40%',
    dataSource: 'Initial audit',
    target: '60%',
    objectiveKey: objective,
  } as const;
  const seed = makePlan([
    {
      key: year,
      base: 'absent',
      record: { kind: 'annual-goal', status: 'active', statement: 'Growth' },
    },
    {
      key: objective,
      base: 'absent',
      record: {
        kind: 'objective',
        status: 'active',
        statement: 'Use',
        quarter: 'Q2',
        annualGoalKey: year,
      },
    },
    { key, base: 'absent', record: { ...original, history: [] } },
  ]);
  await planInIframe(form(a), seed);
  await expect(async () => {
    await sync(form(a));
    expect((await status(form(a), [key])).keys[key]).toMatchObject({ state: 'saved' });
  }).toPass({ timeout: 20_000 });
  await pull(b, key, seed.writes[2]!.value);
  const open = async (profile: StandProfile) => {
    await stand.openPlugin(profile.page);
    await button(profile.frame, original.statement).click({ timeout: 8_000 });
    await button(profile.frame, 'Пересмотреть результат').click({ timeout: 8_000 });
  };
  await Promise.all([open(a), open(b)]);
  const reconnect = await Promise.all([setOffline(a), setOffline(b)]);
  const revise = async (profile: StandProfile, revisionReason: string, target: string) => {
    await profile.frame.getByLabel('Целевое значение').fill(target);
    await profile.frame.getByLabel('Причина пересмотра').fill(revisionReason);
    const write = await submit(profile, '', 'Подтвердить пересмотр');
    expect(decodeRecord(key, write.value)).toMatchObject({
      ok: true,
      value: { ...original, target, history: [{ ...original, revisionReason }] },
    });
    expect(write.base).toBe((JSON.parse(seed.writes[2]!.value) as { ver: string }).ver);
    await committedWrite(profile, write.key, write.value);
    return write.value;
  };
  const values = await Promise.all([
    revise(a, 'Revision A', '63%'),
    revise(b, 'Revision B', '76%'),
  ]);
  expect(values[0]).not.toBe(values[1]);
  await Promise.all(reconnect.map((online) => online()));
  await expect(async () => {
    await sync(form(a));
    await sync(form(b));
    await sync(form(a));
    const winner = await load(form(a), key);
    expect(values).toContain(winner);
    expect(await load(form(b), key)).toBe(winner);
  }).toPass({ timeout: 30_000 });
});

test('The version changes between status and value reads', async ({ stand }) => {
  const { a, b } = await pair(stand);
  const initial = await create(a, 'Receipt baseline');
  await confirm(a, initial);
  const body = form(a);
  const reconnect = await setOffline(a);
  const planned = await submit(a, 'Version being confirmed');
  await body.evaluate(
    (_body, target) => {
      const { key, expectedHash } = target;
      const readStatus = PluginAPI.getSyncedDataSaveState;
      const readValue = PluginAPI.loadSyncedData;
      let signal: (() => void) | undefined;
      let hash: string | undefined;
      const release = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const gate = { hash: '', release: () => signal?.() };
      Object.assign(window, { valueReadBarrier: gate });
      PluginAPI.getSyncedDataSaveState = async (keys) => {
        const reply = await readStatus(keys);
        const current = reply.keys[key];
        if (!gate.hash && current?.state === 'saved' && current.valueSha256 === expectedHash)
          hash = current.valueSha256;
        return reply;
      };
      PluginAPI.loadSyncedData = async (requested) => {
        if (requested === key && hash) {
          gate.hash = hash;
          hash = undefined;
          await release;
        }
        return readValue(requested);
      };
    },
    { key: planned.key, expectedHash: digest(planned.value) },
  );
  await reconnect();
  await sync(body);
  await expect
    .poll(() =>
      body.evaluate(
        () => (window as unknown as { valueReadBarrier: { hash: string } }).valueReadBarrier.hash,
      ),
    )
    .toBe(digest(planned.value));
  const decoded = decodeRecord(planned.key, planned.value);
  if (!decoded.ok || !('kind' in decoded.value) || decoded.value.kind !== 'annual-goal')
    throw new Error('Expected an annual goal');
  const replacement = makePlan([
    {
      key: planned.key,
      base: decoded.value.ver,
      record: { kind: 'annual-goal', status: 'active', statement: 'Newer version' },
    },
  ]);
  const newValue = replacement.writes[0]!.value;
  try {
    await planInIframe(body, replacement);
    await expect.poll(() => load(body, planned.key)).toBe(newValue);
  } finally {
    await body.evaluate(() => {
      (window as unknown as { valueReadBarrier: { release(): void } }).valueReadBarrier.release();
    });
  }

  await expect(a.frame.getByText('Заменено другой версией', { exact: true })).toBeVisible();
  await expect(a.frame.getByText(saved)).toHaveCount(0);
  expect((await draft(body, planned.key))?.fields.statement).toBe('Version being confirmed');
  await sync(body);
  await pull(b, planned.key, newValue);
});

async function watchFirstPollAfterRotation(profile: StandProfile, key: string, originalId: string) {
  await profile.page.exposeBinding('readCommittedDeviceId', () => deviceId(profile.page));
  await form(profile).evaluate(
    (_body, input) => {
      const origin = PluginAPI.getSyncedDataSaveState;
      const observed: { result?: unknown } = {};
      Object.assign(window, { firstRotatedPoll: observed });
      const { readCommittedDeviceId } = window as unknown as {
        readCommittedDeviceId(): Promise<string | undefined>;
      };
      PluginAPI.getSyncedDataSaveState = async (keys) => {
        const watching = observed.result === undefined && keys.includes(input.key);
        const id = watching ? await readCommittedDeviceId() : undefined;
        const result = await origin(keys);
        if (id && id !== input.originalId) observed.result ??= result.keys[input.key];
        return result;
      };
    },
    { key, originalId },
  );
  return () =>
    form(profile).evaluate(
      () =>
        (window as unknown as { firstRotatedPoll: { result?: unknown } }).firstRotatedPoll.result,
    );
}

test('Import revokes confirmation for identical data', async ({ stand }) => {
  const { a: connected, b } = await pair(stand);
  const initial = await create(connected, 'Before import');
  await confirm(connected, initial);
  await expect.poll(() => draft(form(connected), initial.key)).toBeUndefined();
  const a = await openPluginPanel(connected);
  await button(a.frame, 'Before import').click({ timeout: 8_000 });
  const paused = await pauseDraft(form(a), initial.key, 'put');
  const originalValue = 'Identical after import';
  try {
    const write = await submit(a, originalValue);
    await paused.entered();
    await confirm(a, write);
    await pull(b, write.key, write.value);
    const oldId = await deviceId(a.page);
    if (!oldId) throw new Error('Expected the committed client ID before import');
    const first = await watchFirstPollAfterRotation(a, write.key, oldId);
    await exportAndImport(a.page);
    await test.step('Observe the committed client ID rotation', async () => {
      await expect
        .poll(async () => {
          const rotated = await deviceId(a.page);
          return Boolean(rotated && rotated !== oldId);
        })
        .toBe(true);
    });
    await test.step('Observe the first post-rotation poll and the unchanged bytes and version', async () => {
      await expect.poll(first, { timeout: 12_000 }).toEqual({ state: 'unknown' });
      await expect(a.frame.getByText(saved)).toHaveCount(0);
      expect(await load(form(a), write.key)).toBe(write.value);
    });
    await test.step('Release the queued draft and verify it survives', async () => {
      await paused.release();
      await expect.poll(async () => (await paused.read()).outcome).toBe('complete');
      expect((await paused.read()).deletes).toBe(0);
      expect((await draft(form(a), write.key))?.fields.statement).toBe(originalValue);
    });
    const imported = (await stand.openPlugin(a.page)).locator('body');
    expect(await load(imported, write.key)).toBe(write.value);
  } catch (error) {
    await paused.release().catch(() => undefined);
    throw error;
  }
});

for (const abort of [false, true]) {
  const name = 'A newer draft intent arrives during deletion';
  test(abort ? name + ' (the deletion aborts)' : name, async ({ stand }) => {
    const { a, b } = await pair(stand);
    const initial = await create(a, 'Original draft');
    await confirm(a, initial);
    await expect.poll(() => draft(form(a), initial.key)).toBeUndefined();
    const paused = await pauseDraft(form(a), initial.key, 'delete', abort);
    const update = await submit(a, 'Confirmed draft');
    const reason = 'Latest unsubmitted intention';
    const input = a.frame.getByLabel('Причина закрытия');
    try {
      await confirm(a, update);
      await paused.entered();
      await button(a.frame, 'Закрыть запись').click();
      await input.fill(reason);
      await expect(a.frame.getByText(saved)).toHaveCount(0);
    } finally {
      await paused.release();
    }
    await expect.poll(async () => (await paused.read()).outcome).toBe(abort ? 'abort' : 'complete');
    if (abort)
      await test.step('Observe the queued intent and retry the failed draft write', async () => {
        await expect(input).toHaveValue(reason);
        expect(await draft(form(a), update.key)).toMatchObject({
          fields: { action: 'create', statement: 'Confirmed draft' },
        });
        await expect(a.frame.getByText('Черновик на этом устройстве не сохраняется')).toBeVisible();
        expect((await paused.read()).reason).toBe('');
        await button(a.frame, 'Повторить операцию с черновиком').click({ timeout: 8_000 });
      });
    await expect.poll(async () => (await paused.read()).reason).toBe(reason);
    await expect(a.frame.getByText(saved)).toHaveCount(0);
    await expect
      .poll(() => draft(form(a), update.key))
      .toMatchObject({
        fields: { action: 'close', reason },
      });
    await a.page.close();
    const reopened = await stand.openPlugin(await a.context.newPage());
    await button(reopened, 'Confirmed draft').click();
    await expect(reopened.getByLabel('Причина закрытия')).toHaveValue(reason);
    await pull(b, update.key, update.value);
  });
}
