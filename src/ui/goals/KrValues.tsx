import { unconfirmed, unconfirmedMessage, type KrValueEditor } from '../../app/kr-values';

export function KrValues({
  editor,
  view,
}: {
  readonly editor: KrValueEditor;
  readonly view: ReturnType<KrValueEditor['view']>;
}) {
  const blocked = Boolean(view.readOnlyReason || view.wipe || view.conflict);
  const retry = view.retry && !blocked;
  const retryInStatus = view.message === unconfirmedMessage && retry;
  return (
    <section class="card stack" aria-labelledby="kr-values-title">
      <h3 id="kr-values-title">Измерения</h3>
      {view.measurements.length > 0 && (
        <ul class="list">
          {view.measurements.map(({ key, value }) => (
            <li class="list-item" key={key}>
              {value}
            </li>
          ))}
        </ul>
      )}
      {view.readOnlyReason && <p class="callout callout--warning">{view.readOnlyReason}</p>}
      {view.conflict && !view.wipe && (
        <p class="callout callout--warning">
          Сохранённая версия изменилась после создания черновика.
        </p>
      )}
      {(view.live || view.draftKey) && (
        <form
          class="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void editor.save();
          }}
        >
          <div class="field">
            <label htmlFor="kr-value">Фактическое значение</label>
            <textarea
              id="kr-value"
              rows={2}
              value={view.value}
              readOnly={blocked || view.paused}
              aria-invalid={view.errors.length > 0}
              aria-describedby={view.errors.length ? 'kr-value-error' : undefined}
              onInput={(event) => {
                editor.input(event.currentTarget.value);
              }}
            />
            {view.errors.length > 0 && (
              <span id="kr-value-error" class="field-error">
                {view.errors[0]}
              </span>
            )}
          </div>
          {view.message && (
            <p role="status">
              {retryInStatus ? <span>{unconfirmed}</span> : view.message}
              {retryInStatus && ' · '}
              {retryInStatus && (
                <button
                  type="button"
                  class="btn-text"
                  disabled={view.busy}
                  onClick={() => void editor.retry()}
                >
                  Повторить
                </button>
              )}
            </p>
          )}
          {view.draftMessage && (
            <p class="callout callout--warning" role="status">
              {view.draftMessage}
            </p>
          )}
          <div class="row">
            {!blocked && !view.submitted && (
              <button type="submit" class="btn-primary" disabled={view.busy}>
                Внести
              </button>
            )}
            {retry && !retryInStatus && (
              <button
                type="button"
                class="btn-primary"
                disabled={view.busy}
                onClick={() => void editor.retry()}
              >
                Повторить
              </button>
            )}
            {view.conflict && !view.wipe && !view.readOnlyReason && (
              <button type="button" disabled={view.busy} onClick={() => void editor.restore()}>
                Восстановить как новую запись
              </button>
            )}
            {view.draftKey && !view.wipe && (
              <button
                type="button"
                class="btn-text"
                disabled={view.busy}
                onClick={() => void editor.discard()}
              >
                Снять неподтверждённый ввод
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
