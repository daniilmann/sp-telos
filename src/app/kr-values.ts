import { buildPlan, EMPTY_STATE, type Plan } from '../core/plan';
import * as records from '../core/records';
import { sameDraft, type Draft, type DraftStore } from '../platform/draft-store';
import { handoffGoalPlan, removeConfirmedDraft, type ReadSnapshot } from '../platform/facade';
import {
  absent,
  draftError,
  recordAt,
  removalMessages,
  type GoalEditorDependencies as EditorDeps,
  type ApplyOptions,
} from './commands';
import {
  action,
  listKrValueDrafts,
  readDraft,
  readMeasurements,
  type KrValueDraft,
} from './kr-value-drafts';
import { pendingWipe } from './linked-editor-intent';
import { createSaveStatus, saveMessage, type SaveStatus } from './save-status';

export { listKrValueDrafts } from './kr-value-drafts';

const cleared = { input: undefined, rejected: false, error: undefined, receipt: undefined };
export const unconfirmed = 'Сохранение не подтверждено';
export const unconfirmedMessage = `${unconfirmed} · Повторить`;

interface Input extends KrValueDraft {
  observation?: { expected: Draft; outcome?: ReturnType<DraftStore['markObserved']> };
}

function unmarked(input: Input): boolean {
  return input.observation !== undefined && input.observation.outcome?.state !== 'updated';
}

type Dependencies = Pick<EditorDeps, 'facade' | 'drafts' | 'now' | 'newId' | 'onChange'>;

interface Card {
  readonly key: string;
  snapshot?: ReadSnapshot;
  paused?: boolean;
  input?: Input | undefined;
  error?: string | undefined;
  message?: string | undefined;
  draftMessage?: string | undefined;
  wipe?: Awaited<ReturnType<typeof pendingWipe>>;
  confirmed?: Plan['writes'][number] | undefined;
  receipt?: SaveStatus['state'] | undefined;
  saving?: Input | undefined;
  marking?: Promise<void> | undefined;
  removing?: boolean;
  rejected?: boolean;
}

function live(card: Card): boolean {
  const record = recordAt(card.snapshot ?? EMPTY_STATE, card.key);
  return Boolean(record && 'kind' in record && record.kind === 'kr');
}

function wipeVersion(snapshot?: ReadSnapshot): string | undefined {
  const { WIPE_KEY } = records;
  if (!snapshot || snapshot.unreadKeys?.includes(WIPE_KEY)) return undefined;
  return snapshot.entries[WIPE_KEY] === undefined ? absent : recordAt(snapshot, WIPE_KEY)?.ver;
}

function exact(card: Card, write?: Plan['writes'][number]): boolean {
  return write !== undefined && card.snapshot?.entries[write.key] === write.value;
}

function snapshotIssue(card: Card): string | undefined {
  const { snapshot, input } = card;
  if (!snapshot) return undefined;
  if (wipeVersion(snapshot) === undefined) return 'Не удалось прочитать маркер очистки.';
  if (input && snapshot.unreadKeys?.includes(input.key)) return 'Не удалось прочитать измерение.';
  return live(card) ? undefined : 'Ключевой результат удалён или недоступен.';
}

const readOnly = (card: Card) => card.snapshot?.readOnlyReason || snapshotIssue(card);

function conflict(card: Card): boolean {
  const { input, snapshot } = card;
  if (!input || !snapshot) return false;
  const wipe = wipeVersion(snapshot);
  return (
    card.rejected === true ||
    (wipe !== undefined && wipe !== input.expectedWipe) ||
    (snapshot.entries[input.key] !== undefined && !exact(card, input.sent?.write))
  );
}

export function createKrValueEditor({ facade, drafts, now, newId, onChange }: Dependencies) {
  let card: Card = { key: '' };
  let issued = 0;
  let displayed = 0;
  const changed = () => onChange?.();
  const selected = (target: Card) => card === target && !target.paused;
  const owns = (target: Card, input: Input | undefined) =>
    card === target && target.input === input;
  const current = (target: Card, input: Input | undefined) => !target.paused && owns(target, input);
  const consistent = (target: Card) =>
    target.snapshot !== undefined && !snapshotIssue(target) && !target.wipe && !conflict(target);
  const writable = (target: Card) => !target.snapshot?.readOnlyReason && consistent(target);
  const idle = (target: Card) =>
    selected(target) && !target.saving && !target.marking && !target.removing;
  async function sameLocal(input: Input): Promise<boolean> {
    const { failed, value } = await drafts.read(input.key);
    return !failed && value?.at === input.draft.at && sameDraft(value, input.draft);
  }
  const status = createSaveStatus({
    now,
    readSaveState: (keys) => facade.readSaveState(keys),
    async read(keys) {
      const target = card;
      await beginRefresh()(await facade.read([...keys, target.key]));
      // A newer refresh can finish while the poll is reading its snapshot.
      const write = target.confirmed ?? target.input?.sent?.write;
      if (target.draftMessage === draftError || !exact(target, write)) return EMPTY_STATE;
      return target.snapshot ?? EMPTY_STATE;
    },
    onStatus(next) {
      const target = card;
      const { input, confirmed } = target;
      if (!selected(target)) return;
      const visible = exact(target, confirmed ?? input?.sent?.write);
      const result = next.state === 'saved' && !visible ? ({ state: 'replaced' } as const) : next;
      if (confirmed) target.message = result.state === 'saved' ? saveMessage(result) : undefined;
      else if (input) {
        target.receipt = result.state;
        target.message = measurementStatus(result, visible);
        if (result.state === 'saved') void remove(target, input, true);
      }
      changed();
    },
  });

  function stop(target: Card): void {
    status.close(target.key);
    if (target.receipt || target.confirmed) target.message = undefined;
    target.receipt = target.confirmed = undefined;
  }

  async function track(target: Card, input: Input): Promise<void> {
    const { sent } = input;
    const tracking = target.receipt || target.marking || target.draftMessage;
    if (!sent || tracking || !current(target, input) || !writable(target)) return;
    await status.track({ formId: target.key, generation: 0, planId: sent.ver }, sent.plan);
  }

  async function remove(target: Card, input: Input, confirmed = false): Promise<void> {
    if (target.removing || (confirmed && unmarked(input))) return;
    target.removing = true;
    const applicable = () =>
      current(target, input) &&
      (!confirmed ||
        (target.receipt === 'saved' && writable(target) && exact(target, input.sent?.write)));
    try {
      const result = await removeLocal(input, applicable);
      if (!applicable()) return;
      target.draftMessage = result ? removalMessages[result] : undefined;
      if (result !== 'removed') return;
      target.confirmed = confirmed ? input.sent?.write : undefined;
      Object.assign(target, cleared);
      if (!confirmed) target.message = undefined;
    } finally {
      target.removing = false;
      if (card === target) changed();
    }
  }

  async function removeLocal(input: Input, applicable: () => boolean) {
    const { observation, key } = input;
    if (observation && unmarked(input)) {
      if (!(await drafts.flush()).ok) return 'write-failed';
      if (!applicable()) return;
      if (unmarked(input)) {
        const removal = drafts.removeConfirmed(key, observation.expected, applicable, true);
        if (!removal) return;
        const result = await drafts.flush();
        if (removal.state === 'skipped') return 'skipped';
        if (!result.ok) return 'remove-failed';
        return removal.state === 'removed' ? 'removed' : undefined;
      }
    }
    return removeConfirmedDraft(drafts, key, input.draft, applicable);
  }

  function observe(target: Card, input: Input): Promise<void> | undefined {
    const ver = input.sent?.ver;
    // Navigation pauses handoff before flushing, while this card still owns its draft.
    const applicable = () =>
      owns(target, input) &&
      !target.removing &&
      exact(target, input.sent?.write) &&
      consistent(target);
    if (target.marking) return target.marking;
    if (!ver || !applicable() || input.observation?.outcome) return;
    if (!input.observation && input.draft.baseVer === ver) return;

    // Keep require-exact in the live input even if the guarded write fails or is skipped.
    const observation = (input.observation ??= { expected: input.draft });
    input.draft = { ...observation.expected, baseVer: ver };
    const enqueue = () => drafts.markObserved(input.key, observation.expected, ver, applicable);
    const persist = async () => {
      observation.outcome = enqueue();
      if (!observation.outcome) {
        // A queued edit must settle before the observation can compare it on disk.
        const settled = await drafts.flush();
        if (!settled.ok || !applicable()) return settled;
        observation.outcome = enqueue();
      }
      return drafts.flush();
    };
    target.marking = persist().then((result) => {
      target.marking = undefined;
      if (owns(target, input)) target.draftMessage = result.ok ? undefined : draftError;
      if (card === target) changed();
    });
    return target.marking;
  }

  function beginRefresh() {
    const target = card;
    const input = target.input;
    const number = ++issued;
    const latest = () => number >= displayed && current(target, input);
    return async (snapshot: ReadSnapshot) => {
      if (!target.key || !latest()) return;
      const wipe = await pendingWipe(drafts, snapshot);
      if (!latest()) return;
      displayed = number;
      Object.assign(target, { snapshot, wipe });
      if (!writable(target)) stop(target);
      else if (target.confirmed && !exact(target, target.confirmed)) target.message = undefined;
      changed();
      if (!input) return;
      await observe(target, input);
      if (latest() && !target.saving) await track(target, input);
    };
  }

  const keysFor = ({ input, key }: Card) => (input ? [key, input.key] : [key]);

  function select(key: string): void {
    stop(card);
    card = { key };
    changed();
  }

  async function open(key: string, draftKey?: string): Promise<void> {
    select(key);
    const target = card;
    const listed = draftKey ? { keys: [draftKey], failed: false } : await drafts.list();
    const inputs = await listKrValueDrafts(drafts, listed.keys);
    if (!selected(target)) return;
    target.input = inputs.find(({ krKey }) => krKey === key);
    if (listed.failed) target.draftMessage = 'Не удалось прочитать черновики';
    const refresh = beginRefresh();
    const snapshot = await facade.read(keysFor(target)).catch(() => ({
      ...EMPTY_STATE,
      readOnlyReason: 'Не удалось прочитать данные.',
    }));
    await refresh(snapshot);
  }

  function pause(paused = true): void {
    card.paused = paused;
    if (paused) stop(card);
    changed();
  }

  function input(value: string): void {
    const target = card;
    if (!selected(target) || !writable(target)) return;
    stop(target);
    const previous = target.input;
    const reuseKey = previous && !previous.sent && !target.removing;
    const key = reuseKey ? previous.key : records.KR_VALUE_PREFIX + newId();
    const expectedWipe = wipeVersion(target.snapshot) ?? absent;
    const fields = { krKey: target.key, value, expectedWipe, action };
    const draft = { fields, baseVer: absent, at: now() };
    target.input = { key, ...fields, draft };
    target.error = target.message = target.draftMessage = target.saving = undefined;
    drafts.write(key, draft);
    changed();
  }

  function prepare(input?: Input): Input | undefined {
    if (!input?.value.trim() || input.sent) return input?.sent ? input : undefined;
    const { key, krKey, value, draft } = input;
    const at = now();
    const record = { kind: 'kr-value', krKey, value } as const;
    const plan = buildPlan('manual', [{ key, base: absent, record }], { at, newId });
    return readDraft(key, { ...draft, fields: { ...draft.fields, plan }, at });
  }

  async function submit(retry: boolean, source?: Input): Promise<void> {
    const target = card;
    const initial = target.input;
    if (!idle(target) || !writable(target) || (initial?.sent && !retry)) return;
    const attempt = prepare(initial);
    if (!attempt) {
      target.error = initial?.value.trim()
        ? 'Превышен допустимый размер записи.'
        : 'Введите фактическое значение.';
      changed();
      return;
    }
    const applicable = () => current(target, attempt) && writable(target);
    const ready = () => applicable() && !unmarked(attempt);
    target.input = target.saving = attempt;
    if (attempt !== initial) drafts.write(attempt.key, attempt.draft);
    changed();
    try {
      await beginRefresh()(await facade.read(keysFor(target)));
      if (!applicable()) return;
      const settled = await drafts.flush();
      if (!current(target, attempt)) return;
      target.draftMessage = settled.ok ? undefined : draftError;
      if (!settled.ok || !ready() || !(await sameLocal(attempt)) || !ready()) return;
      if (source) await removeLocal(source, ready);
      if (ready()) await handoff(target, attempt, retry);
    } catch {
      if (current(target, attempt)) target.message = saveMessage({ state: 'unknown' });
    } finally {
      if (target.saving === attempt) target.saving = undefined;
      if (card === target) changed();
    }
  }

  async function handoff(target: Card, input: Input, retry: boolean): Promise<void> {
    const { sent, draft, expectedWipe } = input;
    if (!sent) return;
    stop(target);
    target.message = saveMessage({ state: 'pending' });
    changed();
    const options: ApplyOptions = {
      expectedWipe,
      byteCheck: draft.baseVer === absent ? 'allow-absent' : 'require-exact',
      ...(retry && { forceSync: true as const }),
    };
    const refreshFailure = beginRefresh();
    const incomplete = (message: string) => {
      if (!current(target, input) || target.receipt === 'saved') return;
      target.message = message;
      changed();
    };
    const result = await handoffGoalPlan(facade, sent.plan, sent.write, incomplete, options);
    if (!current(target, input)) return;
    if (result.refreshed) {
      await refreshFailure(result.refreshed);
      if (!current(target, input)) return;
      if (!result.applied && options.byteCheck === 'require-exact' && !exact(target, sent.write))
        target.rejected = true;
    }
    await track(target, input);
    if (current(target, input) && result.message) {
      if (target.receipt) target.receipt = 'unknown';
      target.message = result.message.startsWith('Основе передано 0 из 1')
        ? saveMessage({ state: 'failed' })
        : result.message;
    }
  }

  return {
    open,
    close() {
      select('');
    },
    pause,
    beginRefresh,
    input,
    async checkDraft() {
      const target = card;
      const { input } = target;
      const checking = () => idle(target) && !target.draftMessage;
      if (!input || input.sent || !checking()) return;
      const { failed } = await drafts.read(input.key);
      if (!failed || !current(target, input) || !checking()) return;
      target.draftMessage = draftError;
      changed();
    },
    save: () => submit(false),
    retry: () => submit(true),
    async discard() {
      const target = card;
      if (!target.input || !idle(target)) return;
      stop(target);
      await remove(target, target.input);
    },
    restore() {
      const target = card;
      const source = target.input;
      if (!source || !idle(target) || target.wipe || readOnly(target) || !conflict(target)) return;
      Object.assign(target, cleared);
      input(source.value);
      return submit(false, source);
    },
    view() {
      const reason = readOnly(card);
      const alive = live(card);
      return {
        key: card.key,
        ready: card.snapshot !== undefined,
        live: alive,
        measurements: alive ? readMeasurements(card.key, card.snapshot?.entries) : [],
        ...(card.input && { draftKey: card.input.key }),
        value: card.input?.value ?? '',
        busy: !idle(card),
        paused: card.paused,
        errors: card.error ? [card.error] : [],
        message: card.message ?? '',
        draftMessage: card.draftMessage,
        ...(reason && { readOnlyReason: reason }),
        wipe: card.wipe,
        conflict: conflict(card),
        submitted: card.input?.sent !== undefined,
        retry: card.input?.sent !== undefined && card.receipt !== 'pending',
      };
    },
  };
}

function measurementStatus(status: SaveStatus, visible: boolean): string {
  if (status.state === 'retry' && visible) return unconfirmedMessage;
  return saveMessage(status.state === 'replaced' && !visible ? { state: 'retry' } : status);
}

export type KrValueEditor = ReturnType<typeof createKrValueEditor>;
