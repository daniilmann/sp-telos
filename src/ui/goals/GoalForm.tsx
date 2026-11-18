import type { ComponentChildren } from 'preact';
import { recordIntent } from '../../app/commands';
import type { GoalIntent } from '../../app/commands';
import type { GoalEditor } from '../../app/goal-editor';
import type { GoalError, GoalRecord } from '../../core/goals';

type View = ReturnType<GoalEditor['view']>;
export type GoalRecords = Readonly<Record<string, GoalRecord | undefined>>;

export interface FormProps {
  readonly draftActions?: ComponentChildren;
  readonly view: View;
  readonly records: GoalRecords;
  readonly input: (intent: GoalIntent) => void;
  readonly save: () => void;
  readonly retry: () => void;
  readonly back: (choice?: Parameters<GoalEditor['leave']>[0]) => void;
}

export const kindLabels = {
  'annual-goal': { singular: 'Годовая цель', plural: 'Годовые цели' },
  objective: { singular: 'Objective', plural: 'Objectives' },
  kr: { singular: 'Ключевой результат', plural: 'Ключевые результаты' },
};

const fieldLabels = {
  statement: 'Формулировка',
  quarter: 'Квартал',
  annualGoalKey: 'Годовая цель',
  objectiveKey: 'Objective',
  baseline: 'Исходное значение',
  dataSource: 'Источник данных',
  target: 'Целевое значение',
  outcome: 'Исход',
  reason: 'Причина закрытия',
  revisionReason: 'Причина пересмотра',
} satisfies Record<GoalError['field'], string>;

const outcomeLabels = {
  achieved: 'Достигнуто',
  'not-achieved': 'Не достигнуто',
  completed: 'Завершено',
  cancelled: 'Отменено',
};

const errors = {
  required: 'Заполните это поле.',
  'unknown-parent': 'Родительская запись недоступна. Выберите существующую запись.',
  invalid: 'Выберите допустимое значение.',
} satisfies Record<GoalError['code'], string>;

type Field = GoalError['field'];
type Option = readonly [value: string, label: string];

function fieldsFor(kind: GoalRecord['kind'], action: GoalIntent['action']): readonly Field[] {
  if (action === 'close') return ['outcome', 'reason'];
  if (action === 'revise')
    return ['statement', 'baseline', 'dataSource', 'target', 'revisionReason'];
  if (kind === 'annual-goal') return ['statement'];
  if (kind === 'objective') return ['statement', 'quarter', 'annualGoalKey'];
  return ['statement', 'baseline', 'dataSource', 'target', 'objectiveKey'];
}

function fieldOptions(
  field: Field,
  kind: GoalRecord['kind'],
  records: GoalRecords,
): Option[] | undefined {
  if (field === 'outcome') {
    const middle = kind === 'kr' ? 'not-achieved' : 'completed';
    return ['achieved', middle, 'cancelled'].map((outcome) => [
      outcome,
      outcomeLabels[outcome as keyof typeof outcomeLabels],
    ]);
  }
  if (field !== 'annualGoalKey' && field !== 'objectiveKey') return undefined;
  const parentKind = field === 'annualGoalKey' ? 'annual-goal' : 'objective';
  return Object.entries(records).flatMap(([key, record]) =>
    record?.kind === parentKind ? [[key, record.statement] as const] : [],
  );
}

function GoalField({
  field,
  kind,
  view,
  records,
  input,
}: Pick<FormProps, 'view' | 'records' | 'input'> & { field: Field; kind: GoalRecord['kind'] }) {
  const { intent } = view;
  const value = intent.fields[field] ?? '';
  const options = fieldOptions(field, kind, records);
  const error = view.errors.find((item) => item.field === field);
  const id = `goal-${field}`;
  const attributes = {
    id,
    'aria-required': true,
    'aria-invalid': Boolean(error),
    'aria-describedby': error ? `${id}-error` : undefined,
    value,
  };
  const change = (text: string) => {
    input({ ...intent, fields: { ...intent.fields, [field]: text } });
  };
  return (
    <div class="field">
      <label htmlFor={id}>{fieldLabels[field]}</label>
      {options ? (
        <select
          {...attributes}
          onChange={(event) => {
            change(event.currentTarget.value);
          }}
        >
          <option value="">Выберите значение</option>
          {value && !options.some(([key]) => key === value) && (
            <option value={value}>Запись недоступна</option>
          )}
          {options.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      ) : (
        <textarea
          {...attributes}
          rows={field === 'statement' ? 3 : 2}
          onInput={(event) => {
            change(event.currentTarget.value);
          }}
        />
      )}
      {error && (
        <span id={`${id}-error`} class="field-error">
          {errors[error.code]}
        </span>
      )}
    </div>
  );
}

function RecordDetails({
  record,
  records,
}: {
  readonly record: GoalRecord;
  readonly records: GoalRecords;
}) {
  const objectiveKey = record.kind === 'kr' ? record.objectiveKey : undefined;
  const parentKey = record.kind === 'objective' ? record.annualGoalKey : objectiveKey;
  return (
    <>
      {parentKey && <p>Родительская запись — {records[parentKey]?.statement ?? 'недоступна'}</p>}
      {record.status === 'closed' && (
        <p>
          Закрыто · {outcomeLabels[record.outcome]}. {record.closureReason}
        </p>
      )}
      {record.kind === 'kr' && record.history.length > 0 && (
        <details class="card">
          <summary>История пересмотров</summary>
          <ul class="stack">
            {record.history.map((item, index) => (
              <li key={index}>
                <strong>{item.statement}</strong>
                <dl>
                  <dt>Исходное значение</dt>
                  <dd>{item.baseline}</dd>
                  <dt>Источник данных</dt>
                  <dd>{item.dataSource}</dd>
                  <dt>Целевое значение</dt>
                  <dd>{item.target}</dd>
                  <dt>Причина пересмотра</dt>
                  <dd>{item.revisionReason}</dd>
                  {item.status === 'closed' && (
                    <>
                      <dt>Исход</dt>
                      <dd>{outcomeLabels[item.outcome]}</dd>
                      <dt>Причина закрытия</dt>
                      <dd>{item.closureReason}</dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export function GoalForm(props: Readonly<FormProps>) {
  const { view, records } = props;
  const record = view.record && 'kind' in view.record ? view.record : undefined;
  const prefix = view.key.split(':')[0];
  const kind = record?.kind ?? (prefix === 'kr' || prefix === 'objective' ? prefix : 'annual-goal');
  return (
    <section class="stack" aria-labelledby="goal-title">
      <header class="page-header">
        <h2 id="goal-title">{record?.statement ?? kindLabels[kind].singular}</h2>
        <button
          type="button"
          class="btn-text"
          onClick={() => {
            props.back();
          }}
        >
          К списку
        </button>
      </header>
      {record && <RecordDetails record={record} records={records} />}
      {view.message && <p role="status">{view.message}</p>}
      {view.deadline && (
        <p class="callout callout--warning" role="status">
          {view.deadline}
        </p>
      )}
      {props.draftActions}
      {view.ready && <GoalFieldsForm {...props} kind={kind} record={record} />}
    </section>
  );
}

const actionLabels = {
  create: { legend: 'Поля записи', submit: 'Сохранить' },
  edit: { legend: 'Поля записи', submit: 'Сохранить' },
  close: { legend: 'Закрытие', submit: 'Подтвердить закрытие' },
  revise: { legend: 'Пересмотр', submit: 'Подтвердить пересмотр' },
};

interface FieldsProps extends FormProps {
  readonly kind: GoalRecord['kind'];
  readonly record: GoalRecord | undefined;
}

function GoalFieldsForm(props: Readonly<FieldsProps>) {
  const { view, records, input, save, kind, record } = props;
  const { action, fields } = view.intent;
  const blocked = Boolean(view.readOnly || view.draftChoices || view.wipe);
  const retry = view.status === 'retry' || view.status === 'unknown' || view.status === 'replaced';
  const { legend, submit } = actionLabels[action];
  function startRevision(current: GoalRecord): void {
    input({ action: 'revise', fields: action === 'edit' ? fields : recordIntent(current).fields });
  }
  return (
    <form
      class="stack"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <fieldset class="stack" disabled={blocked}>
        <legend>{legend}</legend>
        {fieldsFor(kind, action).map((field) => (
          <GoalField key={field} {...{ field, kind, view, records, input }} />
        ))}
      </fieldset>
      {!blocked && (
        <div class="row">
          {retry ? (
            <button type="button" class="btn-primary" disabled={view.busy} onClick={props.retry}>
              Повторить
            </button>
          ) : (
            <button
              type="submit"
              class="btn-primary"
              disabled={view.busy || view.status === 'pending' || view.status === 'saved'}
            >
              {submit}
            </button>
          )}
          {record?.status === 'active' && action !== 'close' && (
            <button
              type="button"
              disabled={view.busy}
              onClick={() => {
                input({ action: 'close', fields: {} });
              }}
            >
              Закрыть запись
            </button>
          )}
          {record?.kind === 'kr' && action !== 'revise' && (
            <button
              type="button"
              disabled={view.busy}
              onClick={() => {
                startRevision(record);
              }}
            >
              Пересмотреть результат
            </button>
          )}
          {record && (action === 'close' || action === 'revise') && (
            <button
              type="button"
              class="btn-text"
              disabled={view.busy}
              onClick={() => {
                input(recordIntent(record));
              }}
            >
              К правке полей
            </button>
          )}
          {!record && view.status === 'changed' && (
            <button
              type="button"
              class="btn-danger"
              disabled={view.busy}
              onClick={() => {
                props.back('discard');
              }}
            >
              Удалить черновик
            </button>
          )}
        </div>
      )}
    </form>
  );
}
