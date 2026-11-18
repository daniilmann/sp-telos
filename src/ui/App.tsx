import type { GoalIntent } from '../app/commands';
import type { GoalEditor } from '../app/goal-editor';
import type { GoalRecord } from '../core/goals';
import { GoalForm, kindLabels, type FormProps, type GoalRecords } from './goals/GoalForm';

interface AppProps {
  readonly editor: GoalEditor;
  readonly view: ReturnType<GoalEditor['view']>;
  readonly records: GoalRecords;
  readonly draftKeys: readonly string[];
  readonly readOnly: string | undefined;
  readonly message: string;
  readonly open: (key: string) => void;
  readonly create: (kind: GoalRecord['kind']) => void;
  readonly back: (choice?: Parameters<GoalEditor['leave']>[0]) => void;
}

export function App({
  editor,
  view,
  records,
  draftKeys,
  readOnly,
  message,
  open,
  create,
  back,
}: Readonly<AppProps>) {
  const draftActions = {
    view,
    back,
    retryDraft: () => void editor.retryDraftRemoval(),
    resolveDraft: (choice: Parameters<GoalEditor['resolveDraft']>[0]) =>
      void editor.resolveDraft(choice),
    resolveWipe: (choice: Parameters<GoalEditor['resolveWipe']>[0]) =>
      void editor.resolveWipe(choice),
  };
  return (
    <main class="page stack" lang="ru">
      <h1>Цели и результаты</h1>
      {message && <p role="status">{message}</p>}
      {readOnly && readOnly !== view.message && <p class="callout callout--warning">{readOnly}</p>}
      {view.key ? (
        <GoalForm
          view={view}
          records={records}
          input={(intent: GoalIntent) => editor.input(intent)}
          save={() => void editor.save()}
          retry={() => void editor.retry()}
          back={back}
          draftActions={<DraftActions {...draftActions} />}
        />
      ) : (
        <div class="stack">
          {Object.entries(kindLabels).map(([kind, label]) => {
            const recordKind = asKind(kind);
            if (!recordKind) return null;
            const localKeys = draftKeys.filter((key) => key.startsWith(`${kind}:`));
            const rows = Object.entries(records).flatMap(([key, record]) =>
              record?.kind === kind ? [[key, record] as const] : [],
            );
            const unlisted = localKeys.filter((key) => !records[key]);
            return (
              <section key={kind} class="stack">
                <header class="page-header">
                  <h2>{label.plural}</h2>
                  <button
                    type="button"
                    disabled={Boolean(readOnly) || message === 'Загрузка…'}
                    onClick={() => {
                      create(recordKind);
                    }}
                  >
                    Создать
                  </button>
                </header>
                <ul class="list">
                  {rows.map(([key, record]) => (
                    <li class="list-item" key={key}>
                      <button
                        type="button"
                        class="btn-text"
                        onClick={() => {
                          open(key);
                        }}
                      >
                        {record.statement}
                      </button>
                      {record.status === 'closed' && <span class="text-muted">Закрыто</span>}
                      {localKeys.includes(key) && <span class="text-muted">Есть черновик</span>}
                    </li>
                  ))}
                  {unlisted.map((key) => (
                    <li class="list-item" key={key}>
                      <button
                        type="button"
                        onClick={() => {
                          open(key);
                        }}
                      >
                        Продолжить черновик
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}

function asKind(value: string): GoalRecord['kind'] | undefined {
  if (value === 'annual-goal' || value === 'objective' || value === 'kr') return value;
  return undefined;
}

const draftLabels = {
  'keep-draft': 'Применить мой черновик к текущей версии',
  'use-saved': 'Открыть сохранённую версию',
  'discard-draft': 'Удалить черновик',
  'restore-as-new': 'Восстановить как новую запись',
};

const leaveLabels = {
  retry: 'Повторить сохранение черновика',
  stay: 'Остаться',
  discard: 'Уйти без черновика',
};

function DraftActions({
  view,
  retryDraft,
  resolveWipe,
  resolveDraft,
  back,
}: Readonly<Pick<FormProps, 'view' | 'back'>> & {
  readonly retryDraft: () => void;
  readonly resolveWipe: (choice: Parameters<GoalEditor['resolveWipe']>[0]) => void;
  readonly resolveDraft: (choice: Parameters<GoalEditor['resolveDraft']>[0]) => void;
}) {
  const { wipe, draftChoices, leaveChoices, draftMessage, busy } = view;
  return (
    <>
      {draftMessage && (
        <div class="callout callout--warning" role="status">
          <p>{draftMessage}</p>
          <button type="button" onClick={retryDraft}>
            Повторить операцию с черновиком
          </button>
        </div>
      )}
      {leaveChoices && (
        <div class="row">
          {leaveChoices.map((choice) => (
            <button
              type="button"
              key={choice}
              onClick={() => {
                back(choice);
              }}
            >
              {leaveLabels[choice]}
            </button>
          ))}
        </div>
      )}
      {wipe && (
        <div class="callout callout--warning">
          <p>
            Все данные удалены на другом устройстве. Черновиков на этом устройстве: {wipe.count}.
          </p>
          <div class="row">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                resolveWipe('keep');
              }}
            >
              Оставить
            </button>
            <button
              type="button"
              class="btn-danger"
              disabled={busy}
              onClick={() => {
                resolveWipe('discard');
              }}
            >
              Удалить черновики
            </button>
          </div>
        </div>
      )}
      {draftChoices && !wipe && (
        <div class="callout callout--warning">
          <p>
            {draftChoices.includes('restore-as-new')
              ? 'Запись удалена или отсутствует в сохранённых данных.'
              : 'Сохранённая версия изменилась после создания черновика.'}
          </p>
          <div class="row">
            {draftChoices.map((choice) => (
              <button
                type="button"
                key={choice}
                disabled={busy}
                onClick={() => {
                  resolveDraft(choice);
                }}
              >
                {draftLabels[choice]}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
