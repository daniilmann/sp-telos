import type { ComponentChildren } from 'preact';
import type { EditorView, GoalIntent } from '../../app/commands';
import { linkedSource, type LinkedReferences } from '../../app/initiative-task-links';
import {
  changeDirectKrSelection,
  directKrSelection,
  linkedKind,
  sourceField,
  stringField,
} from '../../app/linked-editor-intent';
import { MultipleReferences, ReferencePicker, type ReferenceOptions } from './ReferencePicker';

type LinkListProps = {
  readonly links: LinkedReferences;
  readonly open: (key: string) => void;
  readonly openSource: (source: string) => void;
  readonly discard: (key: string) => void;
};

export function LinkLists({ links, open, openSource, discard }: LinkListProps) {
  return (
    <>
      <LinkedList
        title="Инициативы"
        label="Проект"
        options={links.projects}
        rows={links.initiativeRows}
        liveKeys={links.live}
        archived={links.initiatives}
        {...{ open, openSource, discard }}
      />
      <LinkedList
        title="Связи задач"
        label="Задача"
        options={links.tasks}
        rows={links.taskRows}
        liveKeys={links.live}
        {...{ open, openSource, discard }}
      />
    </>
  );
}

function LinkedList({
  title,
  label,
  options,
  rows,
  liveKeys,
  archived,
  open,
  openSource,
  discard,
}: Omit<LinkListProps, 'links'> & {
  readonly title: string;
  readonly label: string;
  readonly options: LinkedReferences['tasks'];
  readonly rows: LinkedReferences['taskRows'];
  readonly liveKeys: ReadonlySet<string>;
  readonly archived?: LinkedReferences['initiatives'];
}) {
  return (
    <section class="stack">
      <h2>{title}</h2>
      <ReferencePicker
        label={label}
        options={options}
        value=""
        change={(key) => {
          if (key) openSource(key);
        }}
      />
      <ul class="list">
        {rows.map(({ key, title, hasDraft }) => (
          <li class="list-item" key={key}>
            {liveKeys.has(key) && (
              <button
                type="button"
                class="btn-text"
                onClick={() => {
                  open(key);
                }}
              >
                {title}
              </button>
            )}
            {title === 'Недоступно' && <code>{key}</code>}
            {archived?.[key]?.isArchived && <span class="text-muted">Архив</span>}
            {hasDraft && (
              <>
                {!liveKeys.has(key) && <span>{title ?? 'Черновик'}</span>}
                <button
                  type="button"
                  onClick={() => {
                    open(key);
                  }}
                >
                  Продолжить
                </button>
                {!liveKeys.has(key) && (
                  <button
                    type="button"
                    onClick={() => {
                      discard(key);
                    }}
                  >
                    Удалить черновик
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface LinkFormProps {
  readonly view: EditorView;
  readonly links: LinkedReferences;
  readonly input: (intent: GoalIntent) => void;
  readonly save: () => void;
  readonly retry: () => void;
  readonly back: () => void;
  readonly draftActions: ComponentChildren;
}

const types = { 'one-off': { title: 'Разовая' }, regular: { title: 'Регулярная' } };

export function LinkForm({ view, links, input, save, retry, back, draftActions }: LinkFormProps) {
  const kind = linkedKind(view.key);
  if (!kind) return null;
  const record = view.record && 'kind' in view.record ? view.record : undefined;
  const source =
    view.source ?? linkedSource(record) ?? stringField(view.intent.fields, sourceField(kind));
  const origins = kind === 'initiative' ? links.projects : links.tasks;
  const origin = source ? origins[source] : undefined;
  const disabled = Boolean(view.readOnly || view.draftChoices || view.wipe);
  const { intent } = view;
  const changeFields = (fields: GoalIntent['fields']) => {
    input({ ...intent, fields });
  };
  const change = (field: string, value: string | null) => {
    changeFields({ ...intent.fields, [field]: value });
  };
  const title = kind === 'initiative' ? 'Инициатива' : 'Связи задачи';
  return (
    <section class="stack">
      <header class="page-header">
        <h2>
          {title} — {origin?.title ?? 'Недоступно'}
        </h2>
        <button type="button" class="btn-text" onClick={back}>
          К списку
        </button>
      </header>
      {origin && 'isArchived' in origin && origin.isArchived && <p>Архив</p>}
      {view.message && <p role="status">{view.message}</p>}
      {view.deadline && (
        <p class="callout callout--warning" role="status">
          {view.deadline}
        </p>
      )}
      {draftActions}
      {view.ready && (
        <form
          class="stack"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <fieldset class="stack" disabled={disabled}>
            <legend>{title}</legend>
            {kind === 'initiative' ? (
              <InitiativeFields
                record={record?.kind === 'initiative' ? record : undefined}
                {...{ intent, links, change }}
              />
            ) : (
              <TaskFields
                record={record?.kind === 'task-meta' ? record : undefined}
                {...{ intent, links, change, changeFields }}
              />
            )}
          </fieldset>
          {view.errors.map(({ field, code }) => (
            <p class="field-error" key={field}>
              {fieldLabels[field] ?? field} — {errorLabels[code]}
            </p>
          ))}
          {!disabled && <LinkSubmit view={view} retry={retry} />}
        </form>
      )}
    </section>
  );
}

function LinkSubmit({ view, retry }: Pick<LinkFormProps, 'view' | 'retry'>) {
  const retrying =
    view.status === 'retry' || view.status === 'unknown' || view.status === 'replaced';
  return (
    <div class="row">
      {!retrying && (
        <button
          type="submit"
          class="btn-primary"
          disabled={view.busy || view.awaitingRetry || view.status !== 'changed'}
        >
          Сохранить
        </button>
      )}
      {(retrying || view.awaitingRetry) && (
        <button type="button" class="btn-primary" disabled={view.busy} onClick={retry}>
          Повторить
        </button>
      )}
    </div>
  );
}

const fieldLabels: Readonly<Record<string, string>> = {
  krKey: 'KR',
  cadence: 'Периодичность',
  initiativeType: 'Вид',
  initiativeKey: 'Инициатива',
  sphereTagKey: 'Сфера',
  projectKey: 'Проект',
  taskKey: 'Задача',
  directKrKeys: 'Прямые KR',
};
const errorLabels = {
  required: 'Заполните это поле.',
  unavailable: 'Выбранная запись недоступна.',
  invalid: 'Выберите допустимое значение.',
  'unknown-parent': 'Выберите существующую родительскую запись.',
};

type LiveRecord = Extract<NonNullable<EditorView['record']>, { kind: 'initiative' | 'task-meta' }>;
interface FieldsProps<Kind> {
  readonly intent: GoalIntent;
  readonly links: LinkedReferences;
  readonly record: Extract<LiveRecord, { kind: Kind }> | undefined;
  readonly change: (field: string, value: string | null) => void;
}

function InitiativeFields({
  record,
  intent: { fields },
  links,
  change,
}: FieldsProps<'initiative'>) {
  const type = stringField(fields, 'initiativeType') ?? record?.initiativeType ?? '';
  return (
    <>
      <ReferencePicker
        label="KR"
        options={links.krs}
        value={stringField(fields, 'krKey') ?? record?.krKey ?? ''}
        change={(key) => {
          change('krKey', key);
        }}
      />
      <ReferencePicker
        label="Вид"
        options={types}
        value={type}
        change={(value) => {
          change('initiativeType', value);
        }}
      />
      {type === 'regular' && (
        <label class="field">
          <span>Периодичность</span>
          <input
            value={stringField(fields, 'cadence') ?? record?.cadence ?? ''}
            onInput={(event) => {
              change('cadence', event.currentTarget.value);
            }}
          />
        </label>
      )}
    </>
  );
}

function TaskFields({
  record,
  intent: { fields },
  links,
  change,
  changeFields,
}: FieldsProps<'task-meta'> & { readonly changeFields: (fields: GoalIntent['fields']) => void }) {
  const direct = directKrSelection(fields, record?.directKrKeys ?? []);
  return (
    <>
      <ReferencePicker
        label="Инициатива"
        options={links.initiatives}
        placeholder="Без инициативы"
        value={selection(fields, 'initiativeKey', record?.initiativeKey)}
        change={(key) => {
          change('initiativeKey', key || null);
        }}
      />
      <MultipleReferences
        label="Прямые KR"
        options={links.krs}
        values={direct}
        change={(keys) => {
          changeFields(changeDirectKrSelection(fields, direct, keys));
        }}
      />
      <SphereField
        options={links.tags}
        value={selection(fields, 'sphereTagKey', record?.sphereTagKey)}
        change={(key) => {
          change('sphereTagKey', key);
        }}
      />
    </>
  );
}

export function selection(fields: GoalIntent['fields'], key: string, original?: string) {
  return fields[key] === null ? '' : (stringField(fields, key) ?? original ?? '');
}

export function SphereField({
  options,
  value,
  change,
}: {
  readonly options: ReferenceOptions;
  readonly value: string;
  readonly change: (key: string | null) => void;
}) {
  return (
    <ReferencePicker
      label="Сфера"
      options={options}
      value={value}
      placeholder="Без сферы"
      change={(key) => {
        change(key || null);
      }}
    />
  );
}
