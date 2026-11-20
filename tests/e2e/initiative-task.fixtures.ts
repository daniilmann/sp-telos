import type { FrameLocator, Locator } from '@playwright/test';
import type { Task } from '@super-productivity/plugin-api';
import { isPlan, type Plan } from '../../src/core/plan';
import { decodeRecord, splitRecord, type RecordInput } from '../../src/core/records';
import { linkedRecordKey } from '../../src/platform/linked-record-keys';
import {
  button,
  form,
  load,
  makePlan,
  planInIframe,
  receipt,
  saved,
  status,
  sync,
} from './save-confirmation.fixtures';
import { expect, test, type Stand, type StandProfile } from './stand';

export type Write = Plan['writes'][number];
export const titles = {
  annual: 'A durable year',
  objective: 'More returning users',
  kr: ['Retention', 'Visits', 'Replies', 'Referrals'],
};
export const inboxId = 'INBOX_PROJECT';
export const projectKey = (id: string) => 'project:' + id;
export const taskKey = (id: string) => 'task:' + id;
export const tagKey = (id: string) => 'tag:' + id;
export const initiativeKey = (id: string) => linkedRecordKey(projectKey(id));
export const taskMetaKey = (id: string) => linkedRecordKey(taskKey(id));

export function version(write: Pick<Write, 'key' | 'value'>) {
  const parsed = decodeRecord(write.key, write.value);
  if (!parsed.ok) throw new Error('Invalid stored record for ' + write.key);
  return splitRecord(parsed.value);
}

export async function ready(profile: StandProfile) {
  await test.step('The installed ZIP opens the ready goals screen', async () => {
    await expect(profile.frame.getByRole('heading', { name: 'Цели и результаты' })).toBeVisible();
    const goals = profile.frame.locator('section').filter({
      has: profile.frame.getByRole('heading', { name: 'Годовые цели', exact: true }),
    });
    await expect(goals.getByRole('button', { name: 'Создать', exact: true })).toBeEnabled();
  });
}

export function keys(profile: StandProfile, prefix: string) {
  return form(profile).evaluate((_body, prefix) => PluginAPI.listSyncedDataKeys(prefix), prefix);
}

export async function seed(profile: StandProfile, inputs: Parameters<typeof makePlan>[0]) {
  const plan = makePlan(inputs);
  await planInIframe(form(profile), plan);
  for (const write of plan.writes) {
    await expect.poll(() => load(form(profile), write.key)).toBe(write.value);
  }
  return plan.writes;
}

export async function seedGoals(profile: StandProfile) {
  const annual = 'annual-goal:' + crypto.randomUUID();
  const objective = 'objective:' + crypto.randomUUID();
  const kr = titles.kr.map(() => 'kr:' + crypto.randomUUID());
  const writes = await seed(profile, [
    {
      key: annual,
      base: 'absent',
      record: { kind: 'annual-goal', status: 'active', statement: titles.annual },
    },
    {
      key: objective,
      base: 'absent',
      record: {
        kind: 'objective',
        status: 'active',
        statement: titles.objective,
        annualGoalKey: annual,
        quarter: 'Q2',
      },
    },
    ...kr.map((key, index) => ({
      key,
      base: 'absent',
      record: {
        kind: 'kr' as const,
        status: 'active' as const,
        statement: titles.kr[index]!,
        objectiveKey: objective,
        baseline: '0',
        target: '100',
        dataSource: 'Survey',
        history: [],
      },
    })),
  ]);
  return { annual, objective, kr, writes };
}

export async function project(profile: StandProfile, title: string) {
  const id = await form(profile).evaluate((_body, title) => PluginAPI.addProject({ title }), title);
  await expect.poll(() => findProject(profile, id)).toMatchObject({ id, title });
  return id;
}

export async function tag(profile: StandProfile, title: string) {
  const id = await form(profile).evaluate((_body, title) => PluginAPI.addTag({ title }), title);
  await expect.poll(() => findTag(profile, id)).toMatchObject({ id, title });
  return id;
}

export async function task(profile: StandProfile, title: string, projectId = inboxId) {
  const id = await form(profile).evaluate(
    (_body, data) => PluginAPI.addTask({ ...data, isIgnoreShortSyntax: true }),
    { title, projectId },
  );
  await expect.poll(() => findTask(profile, id)).toMatchObject({ id, title, projectId });
  return id;
}

export function findProject(profile: StandProfile, id: string) {
  return form(profile).evaluate(
    async (_body, id) => (await PluginAPI.getAppState()).projects[id],
    id,
  );
}

export function findTag(profile: StandProfile, id: string) {
  return form(profile).evaluate(
    async (_body, id) => (await PluginAPI.getAllTags()).find((item) => item.id === id),
    id,
  );
}

export function findTask(profile: StandProfile, id: string) {
  return form(profile).evaluate(
    async (_body, id) => (await PluginAPI.getTasks()).find((item) => item.id === id),
    id,
  );
}

export async function updateTask(profile: StandProfile, id: string, fields: Partial<Task>) {
  await form(profile).evaluate((_body, { id, fields }) => PluginAPI.updateTask(id, fields), {
    id,
    fields,
  });
  await expect.poll(() => findTask(profile, id)).toMatchObject({ id, ...fields });
}

export async function reopen(stand: Stand, profile: StandProfile) {
  profile.frame = await stand.openPlugin(profile.page);
  await ready(profile);
}

export const field = (frame: FrameLocator, label: string) =>
  frame.getByLabel(label, { exact: true });

export async function choose(control: Locator, label: string) {
  await control.selectOption({ label }, { timeout: 8_000 });
}

export async function openLinked(
  stand: Stand,
  profile: StandProfile,
  label: 'Проект' | 'Задача',
  title: string,
) {
  await reopen(stand, profile);
  await pickLinked(profile, label, title);
}

export async function pickLinked(profile: StandProfile, label: 'Проект' | 'Задача', title: string) {
  const select = field(profile.frame, label);
  await expect(
    select,
    'The installed ZIP exposes the ' + label + ' reference picker',
  ).toBeVisible();
  await choose(select, title);
  await expect(button(profile.frame, 'Сохранить')).toBeVisible();
}

export async function openRow(stand: Stand, profile: StandProfile, title: string) {
  await reopen(stand, profile);
  const row = button(profile.frame, title);
  await expect(row, 'The installed ZIP renders the saved linked record ' + title).toBeVisible();
  await row.click();
}

export async function chooseKrs(frame: FrameLocator, labels: string[]) {
  await field(frame, 'Прямые KR').selectOption(labels.map((label) => ({ label })));
}

export async function selectInitiative(
  profile: StandProfile,
  options: { kr: string; cadence?: string },
) {
  const { frame } = profile;
  await choose(field(frame, 'KR'), options.kr);
  await choose(field(frame, 'Вид'), options.cadence === undefined ? 'Разовая' : 'Регулярная');
  if (options.cadence !== undefined) await field(frame, 'Периодичность').fill(options.cadence);
}

export async function expectChoice(control: Locator, expected: string | string[]) {
  const selected = control.locator('option:checked');
  if (typeof expected === 'string') {
    await expect(selected).toHaveText(expected);
    return;
  }
  await expect
    .poll(async () => new Set(await selected.allTextContents()))
    .toEqual(new Set(expected));
}

export async function observePlans(profile: StandProfile) {
  const observation = await profile.frame.owner().evaluateHandle((iframe) => {
    const source = (iframe as HTMLIFrameElement).contentWindow;
    const plans: unknown[] = [];
    const listener = (
      event: MessageEvent<{ type?: string; message?: { cmd?: string; plan?: unknown } } | null>,
    ) => {
      if (
        event.origin === window.location.origin &&
        Object.is(event.source, source) &&
        event.data?.type === 'PLUGIN_MESSAGE' &&
        event.data.message?.cmd === 'apply'
      ) {
        plans.push(event.data.message.plan);
      }
    };
    window.addEventListener('message', listener);
    return {
      plans,
      stop: () => {
        window.removeEventListener('message', listener);
      },
    };
  });
  return {
    read: () => observation.evaluate(({ plans }) => plans),
    async dispose() {
      await observation.evaluate(({ stop }) => {
        stop();
      });
      await observation.dispose();
    },
  };
}

export async function save(profile: StandProfile, key: string, expected: RecordInput) {
  const observer = await observePlans(profile);
  try {
    const before = await load(form(profile), key);
    await button(profile.frame, 'Сохранить').click();
    await expect
      .poll(observer.read, { message: 'The form hands off one real save plan' })
      .toHaveLength(1);
    const [plan] = await observer.read();
    if (!isPlan(plan)) throw new Error('Expected a valid plan from the form');
    expect(plan.writes).toHaveLength(1);
    const write = plan.writes[0]!;
    expect(write.key).toBe(key);
    expect(write.base).toBe(before === null ? 'absent' : version({ key, value: before }).ver);
    const target = version(write);
    expect(target.ver).not.toBe(write.base);
    if ('kind' in expected && expected.kind === 'task-meta' && expected.directKrKeys) {
      expect(target.record).toEqual({ ...expected, directKrKeys: expect.any(Array) });
      const directKrKeys = 'directKrKeys' in target.record ? target.record.directKrKeys : [];
      expect(directKrKeys).toHaveLength(expected.directKrKeys.length);
      expect(directKrKeys).toEqual(expect.arrayContaining([...expected.directKrKeys]));
      if (before !== null) {
        const previous = version({ key, value: before }).record;
        const previousKeys = 'directKrKeys' in previous ? previous.directKrKeys : [];
        if (
          previousKeys.length === expected.directKrKeys.length &&
          expected.directKrKeys.every((key) => previousKeys.includes(key))
        ) {
          expect(directKrKeys).toEqual(previousKeys);
        }
      }
    } else {
      expect(target.record).toEqual(expected);
    }
    await expect.poll(() => load(form(profile), key)).toBe(write.value);
    return write;
  } finally {
    await observer.dispose();
  }
}

export async function confirmWrite(profile: StandProfile, write: Write) {
  await expect(async () => {
    await sync(form(profile));
    const current = await load(form(profile), write.key);
    expect(current).toBe(write.value);
    expect(version({ key: write.key, value: current! }).ver).toBe(version(write).ver);
    expect((await status(form(profile), [write.key])).keys[write.key]).toEqual(
      receipt(write.value),
    );
  }).toPass({ timeout: 30_000 });
  await expect(profile.frame.getByText(saved)).toBeVisible();
}

export async function expectBytes(
  profile: StandProfile,
  writes: readonly Pick<Write, 'key' | 'value'>[],
) {
  for (const { key, value } of writes) expect(await load(form(profile), key), key).toBe(value);
}

export async function deleteTask(profile: StandProfile, id: string) {
  await form(profile).evaluate((_body, id) => PluginAPI.deleteTask(id), id);
  await expect.poll(() => findTask(profile, id)).toBeUndefined();
}

export async function restoreDeletedTask(
  stand: Stand,
  profile: StandProfile,
  id: string,
  title: string,
) {
  await profile.page.goto(new URL('/#/tag/TODAY/history', profile.page.url()).href);
  await profile.page.locator('history .recently-deleted-btn').click({ timeout: 10_000 });
  const dialog = profile.page.locator('dialog-recently-deleted');
  const entry = dialog.locator('.entry').filter({ hasText: title });
  await expect(entry).toHaveCount(1);
  await entry.locator('.restore-btn').click();
  await expect(entry).toHaveCount(0);
  await dialog.locator('button[mat-dialog-close]').click();
  await reopen(stand, profile);
  await expect.poll(() => findTask(profile, id)).toMatchObject({ id, title });
}

export async function repeatInstances(profile: StandProfile, repeatCfgId: string) {
  return form(profile).evaluate(
    async (_body, id) => (await PluginAPI.getTasks()).filter((task) => task.repeatCfgId === id),
    repeatCfgId,
  );
}

export async function startDailyRepeat(stand: Stand, profile: StandProfile, title: string) {
  const date = new Date();
  date.setDate(date.getDate() - 2);
  date.setHours(12, 0, 0, 0);
  await profile.page.clock.setSystemTime(date);
  await profile.page.reload();
  await reopen(stand, profile);
  const original = await task(profile, title);
  await profile.page
    .getByRole('menuitem', { name: 'Inbox', exact: true })
    .click({ timeout: 8_000 });
  const row = profile.page.locator('task').filter({ hasText: title });
  await expect(async () => {
    await row.hover({ timeout: 2_000 });
    await row.getByRole('button', { name: 'Show/hide task panel' }).click({ timeout: 2_000 });
  }).toPass({ timeout: 10_000 });
  const scheduleItem = profile.page
    .locator('task-detail-item')
    .filter({
      has: profile.page.locator('mat-icon', { hasText: /^(alarm|today|schedule|repeat)$/ }),
    })
    .first();
  await scheduleItem.click({ timeout: 8_000 });
  const schedule = profile.page.locator('dialog-schedule-task');
  await schedule.locator('[data-test-id="schedule-repeat-field"]').click({ timeout: 8_000 });
  const dialog = profile.page.locator('dialog-edit-task-repeat-cfg');
  await dialog.getByRole('button', { name: /Save/i }).click({ timeout: 8_000 });
  await expect(dialog).toBeHidden();
  if (await schedule.isVisible())
    await schedule.locator('[data-test-id="schedule-cancel-btn"]').click();
  await reopen(stand, profile);
  await expect.poll(async () => (await findTask(profile, original))?.repeatCfgId).toBeTruthy();
  const repeatCfgId = (await findTask(profile, original))!.repeatCfgId!;
  await updateTask(profile, original, { isDone: true });

  return {
    original,
    repeatCfgId,
    async next(previous: readonly string[]): Promise<Task> {
      date.setDate(date.getDate() + 1);
      await profile.page.clock.setSystemTime(date);
      await profile.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const newer = async () =>
        (await repeatInstances(profile, repeatCfgId)).filter((item) => !previous.includes(item.id));
      await expect.poll(newer, { timeout: 30_000 }).toHaveLength(1);
      const [instance] = await newer();
      expect(instance).toMatchObject({ title, repeatCfgId });
      return instance!;
    },
  };
}
