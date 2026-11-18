import { randomUUID } from 'node:crypto';
import type { FrameLocator } from '@playwright/test';
import { buildPlan } from '../../src/core/plan';
import { planInIframe } from './save-confirmation.fixtures';
import { expect, test } from './stand';

const annual = 'Годовые цели';
const objectives = 'Objectives';
const results = 'Ключевые результаты';
const statement = 'Формулировка';
const baseline = 'Исходное значение';
const source = 'Источник данных';
const target = 'Целевое значение';
const objective = 'Objective';
const invalid = 'Проверьте данные и действие формы.';
const missingParent = 'Родительская запись недоступна. Выберите существующую запись.';
const fields = { [statement]: 'Retention', [baseline]: '45%', [source]: 'Survey', [target]: '60%' };

function button(frame: FrameLocator, name: string) {
  return frame.getByRole('button', { name, exact: true });
}

function list(frame: FrameLocator, name: string) {
  return frame
    .locator('section')
    .filter({ has: frame.getByRole('heading', { name, exact: true }) });
}

async function create(frame: FrameLocator, kind: string) {
  await expect(frame.getByRole('heading', { name: kind, exact: true })).toBeVisible();
  await list(frame, kind).getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(frame.getByLabel(statement)).toBeEditable();
}

async function fill(frame: FrameLocator, values: Record<string, string>) {
  for (const [label, value] of Object.entries(values)) await frame.getByLabel(label).fill(value);
}

async function submit(frame: FrameLocator, title: string, action = 'Сохранить') {
  await button(frame, action).click();
  await expect(frame.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(button(frame, action)).not.toBeEnabled();
}

async function back(frame: FrameLocator) {
  await button(frame, 'К списку').click();
  await expect(frame.getByRole('heading', { name: annual })).toBeVisible();
}

async function reopen(frame: FrameLocator, title: string) {
  await back(frame);
  await button(frame, title).click();
  await expect(frame.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

function records(frame: FrameLocator, prefix: string) {
  return frame.locator('body').evaluate(async (_body, collection) => {
    const keys = await PluginAPI.listSyncedDataKeys(collection);
    return Object.fromEntries(
      await Promise.all(keys.map(async (key) => [key, await PluginAPI.loadSyncedData(key)])),
    );
  }, prefix);
}

async function createParents(frame: FrameLocator) {
  await create(frame, annual);
  await fill(frame, { [statement]: 'Growth' });
  await submit(frame, 'Growth');
  await back(frame);
  await create(frame, objectives);
  await fill(frame, { [statement]: 'Returning users', Квартал: 'Q2' });
  await frame.getByLabel('Годовая цель', { exact: true }).selectOption({ label: 'Growth' });
  await submit(frame, 'Returning users');
  await back(frame);
}

async function createKr(frame: FrameLocator) {
  await create(frame, results);
  await fill(frame, fields);
  await frame.getByLabel(objective, { exact: true }).selectOption({ label: 'Returning users' });
  await submit(frame, fields[statement]);
}

async function close(frame: FrameLocator, title: string, outcome: string, reason: string) {
  await button(frame, 'Закрыть запись').click();
  await frame.getByLabel('Исход', { exact: true }).selectOption({ label: outcome });
  await frame.getByLabel('Причина закрытия', { exact: true }).fill(reason);
  await submit(frame, title, 'Подтвердить закрытие');
  await expect(frame.getByText(`Закрыто · ${outcome}. ${reason}`, { exact: true })).toBeVisible();
}

async function onlyRecord(frame: FrameLocator, prefix: string) {
  const rows = Object.entries(await records(frame, prefix));
  expect(rows).toHaveLength(1);
  const [key, raw] = rows[0]!;
  if (typeof raw !== 'string') throw new Error(`Missing saved value for ${key}`);
  return { key, value: JSON.parse(raw) as Record<string, unknown> };
}

async function rejectField(frame: FrameLocator, label: string, message: string) {
  await button(frame, 'Сохранить').click();
  await expect(frame.getByText(invalid, { exact: true })).toBeVisible();
  await expect(frame.getByLabel(label, { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(frame.getByLabel(label, { exact: true })).toHaveAccessibleDescription(message);
}

async function removeParent(frame: FrameLocator, key: string, base: string) {
  const plan = buildPlan('manual', [{ key, base, record: { deleted: true } }], {
    at: Date.now(),
    newId: randomUUID,
  });
  await planInIframe(frame.locator('body'), plan);
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate((_body, parentKey) => PluginAPI.loadSyncedData(parentKey), key),
    )
    .toBe(plan.writes[0]!.value);
}

test('owner creates edits and closes the three records', async ({ stand }) => {
  const { frame } = await stand.newProfile();
  await createParents(frame);
  await createKr(frame);
  const { key: parent } = await onlyRecord(frame, 'objective:');
  const { key: year } = await onlyRecord(frame, 'annual-goal:');
  const entries = [
    {
      name: 'Growth',
      next: 'Sustainable growth',
      prefix: 'annual-goal:',
      relation: {},
      label: 'Завершено',
      outcome: 'completed',
    },
    {
      name: 'Returning users',
      next: 'Returning customers',
      prefix: 'objective:',
      relation: { annualGoalKey: year, quarter: 'Q2' },
      label: 'Достигнуто',
      outcome: 'achieved',
    },
    {
      name: fields[statement],
      next: 'Repeat use',
      prefix: 'kr:',
      relation: {
        objectiveKey: parent,
        baseline: '45%',
        dataSource: 'Survey',
        target: '60%',
        history: [],
      },
      label: 'Не достигнуто',
      outcome: 'not-achieved',
    },
  ];
  for (const { name, next, prefix, relation, label, outcome } of entries) {
    await reopen(frame, name);
    const initial = await onlyRecord(frame, prefix);
    expect(initial.value).toMatchObject({ ...relation, statement: name, status: 'active' });
    await fill(frame, { [statement]: next });
    await submit(frame, next);
    const edited = await onlyRecord(frame, prefix);
    expect(edited.key).toBe(initial.key);
    expect(edited.value).toMatchObject({ ...relation, statement: next, status: 'active' });
    expect(edited.value.ver).not.toBe(initial.value.ver);

    const reason = `Reviewed ${next}`;
    await close(frame, next, label, reason);
    await reopen(frame, next);
    await expect(frame.getByText(`Закрыто · ${label}. ${reason}`, { exact: true })).toBeVisible();
    const closed = await onlyRecord(frame, prefix);
    expect(closed.key).toBe(initial.key);
    expect(closed.value).toMatchObject({
      ...relation,
      statement: next,
      status: 'closed',
      outcome,
      closureReason: reason,
    });
    expect(closed.value.ver).not.toBe(edited.value.ver);
  }
  await expect(frame.getByText('Родительская запись — Returning customers')).toBeVisible();
});

test('invalid Objective and KR cannot be saved', async ({ stand }) => {
  const { frame } = await stand.newProfile();
  const required = 'Заполните это поле.';
  await create(frame, objectives);
  await fill(frame, { [statement]: 'Without annual goal', Квартал: 'Q2' });
  await rejectField(frame, 'Годовая цель', required);
  expect(await records(frame, 'objective:')).toEqual({});
  await button(frame, 'Удалить черновик').click();
  await createParents(frame);
  await createKr(frame);
  const initial = await records(frame, 'kr:');

  await reopen(frame, fields[statement]);
  const parentField = frame.getByLabel(objective, { exact: true });
  const { key, value } = await onlyRecord(frame, 'objective:');
  await parentField.selectOption('');
  await rejectField(frame, objective, required);
  expect(await records(frame, 'kr:')).toEqual(initial);
  await parentField.selectOption(key);
  await back(frame);

  await create(frame, results);
  await fill(frame, fields);
  await rejectField(frame, objective, required);
  expect(await records(frame, 'kr:')).toEqual(initial);
  await parentField.selectOption(key);
  for (const [label, text] of Object.entries(fields)) {
    await fill(frame, { [label]: label === statement ? '   ' : '' });
    await rejectField(frame, label, required);
    expect(await records(frame, 'kr:')).toEqual(initial);
    await fill(frame, { [label]: text });
  }

  await fill(frame, { [target]: '' });
  await removeParent(frame, key, String(value.ver));
  await fill(frame, { [target]: fields[target] });
  await rejectField(frame, objective, missingParent);
  expect(await records(frame, 'kr:')).toEqual(initial);
  await button(frame, 'Удалить черновик').click();

  await button(frame, fields[statement]).click();
  await expect(parentField).toHaveValue(key);
  await expect(parentField.locator('option:checked')).toHaveText('Запись недоступна');
  await fill(frame, { [statement]: 'Edit with a removed parent' });
  await rejectField(frame, objective, missingParent);
  expect(await records(frame, 'kr:')).toEqual(initial);
});

for (const isClosed of [false, true]) {
  const name = isClosed
    ? 'owner revises a closed KR without changing its closure'
    : 'owner revises the KR and sees one previous version';
  test(name, async ({ stand }) => {
    const { frame } = await stand.newProfile();
    await createParents(frame);
    await createKr(frame);
    if (isClosed) await close(frame, fields[statement], 'Не достигнуто', 'Original closure');
    const original = await onlyRecord(frame, 'kr:');

    await button(frame, 'Пересмотреть результат').click();
    await fill(frame, {
      [statement]: 'Repeat use',
      [baseline]: '50%',
      [source]: 'Audit',
      [target]: '65%',
      'Причина пересмотра': 'New scope',
    });
    await submit(frame, 'Repeat use', 'Подтвердить пересмотр');
    await reopen(frame, 'Repeat use');
    await frame.getByText('История пересмотров', { exact: true }).click();
    const items = frame.locator('details').getByRole('listitem');
    await expect(items).toHaveCount(1);
    for (const text of [...Object.values(fields), 'New scope']) {
      await expect(items.getByText(text, { exact: true })).toBeVisible();
    }

    const updated = await onlyRecord(frame, 'kr:');
    const { v, at, ver, history, ...previous } = original.value;
    expect({ v, at, ver, history }).toMatchObject({
      v: 1,
      at: expect.any(Number),
      ver: expect.any(String),
      history: [],
    });
    expect(updated.key).toBe(original.key);
    expect(updated.value.ver).not.toBe(ver);
    expect(updated.value).toMatchObject({
      statement: 'Repeat use',
      baseline: '50%',
      dataSource: 'Audit',
      target: '65%',
      objectiveKey: previous.objectiveKey,
      status: previous.status,
      ...(isClosed && { outcome: 'not-achieved', closureReason: 'Original closure' }),
    });
    expect(updated.value.history).toEqual([{ ...previous, revisionReason: 'New scope' }]);
    if (isClosed) {
      await expect(frame.getByText('Закрыто · Не достигнуто. Original closure')).toBeVisible();
      await expect(items.getByText('Original closure', { exact: true })).toBeVisible();
    }
  });
}
