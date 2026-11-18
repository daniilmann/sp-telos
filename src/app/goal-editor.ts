import { sameDraft, type Draft } from '../platform/draft-store';
import {
  handleDraftWipe,
  handoffGoalPlan,
  removeConfirmedDraft,
  type ReadSnapshot,
} from '../platform/facade';
import {
  absent,
  changed,
  updatedInput,
  draftError,
  failedRemoval,
  removalMessages,
  leaveFailed,
  afterWipe,
  afterDraftDiscard,
  applyHandoffToSnapshot,
  draftChoices,
  readEditor,
  prepareGoalPlan,
  recordAt,
  recordIntent,
  type DraftChoice,
  type EditorView,
  type LeaveChoice,
  type GoalIntent,
  type GoalDraft,
  type GoalEditorDependencies,
  type Submission,
} from './commands';
import { createSaveStatus, saveMessage } from './save-status';

const EDIT_INTERVAL_MS = 2000;

export function createGoalEditor({
  facade,
  drafts,
  now,
  newId,
  onChange,
  onRead,
}: GoalEditorDependencies) {
  const initial: EditorView = { key: '', baseVer: absent, intent: recordIntent(), errors: [] };
  let view = initial;
  let formId = '';
  let generation = 0;
  let submission: Submission | undefined;
  let handoffVer: string | undefined;
  let confirmation: { readonly sent: Submission; readonly draft: Draft } | undefined;
  let removing: typeof confirmation;
  let scheduledSave:
    | { readonly timer: ReturnType<typeof setTimeout>; readonly cancel: () => void }
    | undefined;
  const lastSentByKey = new Map<string, number>();
  let dirty = false;
  const status = createSaveStatus({
    read: (keys) => facade.read(keys),
    readSaveState: (keys) => facade.readSaveState(keys),
    now,
    onStatus(next) {
      if (next.state !== 'saved') confirmation = undefined;
      update({
        status: next.state,
        message: saveMessage(next),
        ...(next.state === 'saved' && { deadline: undefined }),
      });
      if (next.state === 'saved' && submission?.generation === generation && !confirmation) {
        const proof = { sent: submission, draft: currentDraft() };
        confirmation = proof;
        void removeConfirmed(proof);
      }
    },
  });

  function update(patch: Partial<EditorView>): void {
    view = { ...view, ...patch };
    onChange?.();
  }

  function currentDraft(): GoalDraft {
    return {
      at: now(),
      ...(handoffVer && { handoffVer }),
      baseVer: view.baseVer,
      fields: { ...view.intent.fields, action: view.intent.action },
    };
  }

  function storeDraft(): void {
    drafts.write(view.key, currentDraft());
  }

  async function removeConfirmed(proof: NonNullable<typeof confirmation>): Promise<void> {
    const id = formId;
    const applicable = () =>
      formId === id &&
      confirmation === proof &&
      submission === proof.sent &&
      generation === proof.sent.generation &&
      sameDraft(currentDraft(), proof.draft);
    if (!applicable() || removing === proof) return;
    removing = proof;
    try {
      const result = await removeConfirmedDraft(
        drafts,
        proof.sent.write.key,
        proof.draft,
        applicable,
      );
      if (!applicable() || !result) return;
      if (result === 'removed') dirty = false;
      update({ draftMessage: removalMessages[result] });
    } finally {
      if (removing === proof) removing = undefined;
    }
  }

  function invalidate(): void {
    generation += 1;
    handoffVer = undefined;
    confirmation = undefined;
    status.invalidate(formId, generation);
  }

  function cancelScheduledSave(): void {
    if (!scheduledSave) return;
    clearTimeout(scheduledSave.timer);
    scheduledSave.cancel();
    scheduledSave = undefined;
  }

  function close(): void {
    cancelScheduledSave();
    status.close(formId);
    formId = '';
    submission = undefined;
    handoffVer = undefined;
    confirmation = undefined;
    dirty = false;
    view = initial;
    onChange?.();
  }

  async function open(key: string): Promise<void> {
    close();
    const id = newId();
    formId = id;
    update({ key, message: 'Загрузка…' });
    try {
      const opened = await readEditor(facade, drafts, key);
      if (formId !== id) return;
      dirty = opened.dirty;
      handoffVer = opened.handoffVer;
      onRead?.(opened.snapshot);
      update(opened.view);
    } catch {
      if (formId === id) update({ message: 'Не удалось прочитать данные.' });
    }
  }

  function editingText(): boolean {
    return view.intent.action === 'create' || view.intent.action === 'edit';
  }

  function remainingDelay(): number {
    const lastSent = lastSentByKey.get(view.key);
    return lastSent === undefined ? 0 : Math.max(0, lastSent + EDIT_INTERVAL_MS - now());
  }

  function delaySave(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        scheduledSave = undefined;
        resolve(save());
      }, delay);
      scheduledSave = { timer, cancel: resolve };
    });
  }

  function scheduleSave(): void {
    if (scheduledSave || view.busy || view.draftChoices || view.wipe || !editingText()) return;
    void delaySave(remainingDelay() || EDIT_INTERVAL_MS);
  }

  async function checkDraft(): Promise<void> {
    if (!dirty || !view.ready) return;
    const current = view;
    const result = await drafts.read(current.key);
    if (view === current && result.failed && !view.draftMessage)
      update({ draftMessage: draftError });
  }

  function input(intent: GoalIntent): boolean {
    if (!view.ready || view.readOnly || view.draftChoices || view.wipe) return false;
    if (intent.action === 'close' || intent.action === 'revise') cancelScheduledSave();
    invalidate();
    dirty = true;
    update({ ...updatedInput, intent });
    storeDraft();
    scheduleSave();
    return true;
  }

  async function save(retry = false): Promise<void> {
    if (
      (!dirty && !(retry && submission)) ||
      view.busy ||
      view.readOnly ||
      view.draftChoices ||
      view.wipe
    )
      return;
    if (!retry && submission?.generation === generation) return;
    cancelScheduledSave();
    const delay = !retry && editingText() ? remainingDelay() : 0;
    return delay > 0 ? delaySave(delay) : submit(retry);
  }

  async function submit(retry: boolean): Promise<void> {
    const { key, baseVer, intent } = view;
    const id = formId;
    const epoch = generation;
    const currentForm = () => formId === id && generation === epoch;
    const previous = submission;
    status.close(id);
    confirmation = undefined;
    update({ busy: true, errors: [], deadline: undefined });
    try {
      const snapshot = await facade.read([key]);
      if (!currentForm()) return;
      onRead?.(snapshot);
      if (snapshot.readOnlyReason) {
        update({ readOnly: true, message: snapshot.readOnlyReason });
        return;
      }
      const previousValue =
        previous?.generation === epoch && previous.write.key === key
          ? previous.write.value
          : undefined;
      const prepared = prepareGoalPlan({
        state: snapshot,
        key,
        baseVer,
        intent,
        previousValue,
        handoffVer,
        at: now(),
        newId,
      });
      if ('choices' in prepared) {
        update({
          record: prepared.record,
          draftChoices: prepared.choices,
          status: 'replaced',
          message: 'Заменено другой версией',
        });
        return;
      }
      if ('errors' in prepared) {
        update({ errors: prepared.errors, message: prepared.message });
        return;
      }
      const { plan, write } = prepared;
      const sent = { write, generation: epoch };
      submission = sent;
      lastSentByKey.set(key, now());
      update({ status: 'pending', message: 'Сохраняется…' });
      const result = await handoffGoalPlan(
        facade,
        plan,
        write,
        (deadline) => {
          if (currentForm() && submission === sent && view.status !== 'saved') update({ deadline });
        },
        retry,
      );
      if (formId !== id) return;
      if (result.applied) acceptHandoff(write, baseVer, snapshot, currentForm());
      if (!currentForm()) return;
      await status.track({ formId: id, generation: epoch, planId: newId() }, plan);
      if (!currentForm()) return;
      if (result.message) update({ status: 'unknown', message: result.message });
    } catch {
      if (currentForm()) update({ status: 'unknown', message: 'Состояние неизвестно' });
    } finally {
      if (formId === id) {
        update({ busy: false });
        if (!currentForm()) scheduleSave();
      }
    }
  }

  function acceptHandoff(
    write: Submission['write'],
    baseVer: string,
    snapshot: ReadSnapshot,
    sameIntent: boolean,
  ): void {
    if (view.key !== write.key || view.baseVer !== baseVer) return;
    const state = applyHandoffToSnapshot(snapshot, write);
    const record = recordAt(state, write.key);
    if (!record) return;
    if (sameIntent) handoffVer = record.ver;
    update({ baseVer: record.ver, record });
    storeDraft();
    onRead?.(state);
  }

  async function resolveDraft(choice: DraftChoice): Promise<void> {
    if (!view.draftChoices?.includes(choice) || view.wipe || view.busy) return;
    const { key, record, intent } = view;
    const id = formId;
    invalidate();
    update({ busy: true });
    try {
      const snapshot = await facade.read([key]);
      if (formId !== id) return;
      const remote = recordAt(snapshot, key);
      if (remote?.ver !== record?.ver) {
        update({ record: remote, draftChoices: draftChoices(remote, view.baseVer) });
        return;
      }
      if (choice === 'keep-draft') {
        update({
          baseVer: remote?.ver ?? absent,
          draftChoices: undefined,
          status: 'changed',
          message: changed,
        });
        storeDraft();
        return;
      }
      if (choice === 'restore-as-new') {
        const newKey = `${key.split(':')[0] ?? ''}:${newId()}`;
        update({
          key: newKey,
          baseVer: absent,
          intent: { ...intent, action: 'create' },
          record: undefined,
          draftChoices: undefined,
          status: 'changed',
          message: changed,
        });
        storeDraft();
        if (!(await drafts.flush()).ok) {
          if (formId === id) update({ draftMessage: draftError });
          return;
        }
        if (formId !== id) return;
      }
      drafts.remove(key);
      if (choice !== 'restore-as-new') {
        dirty = false;
        update(afterDraftDiscard(remote));
      }
      const result = await drafts.flush();
      if (formId === id) update({ draftMessage: result.ok ? undefined : failedRemoval });
    } catch {
      if (formId === id) update({ message: 'Не удалось прочитать данные.' });
    } finally {
      if (formId === id) update({ busy: false });
    }
  }

  async function resolveWipe(choice: 'keep' | 'discard'): Promise<void> {
    if (!view.wipe || view.busy) return;
    const { ver } = view.wipe;
    const id = formId;
    const discard = choice === 'discard';
    update({ busy: true });
    const handled = await handleDraftWipe(drafts, ver, discard, () => formId === id);
    if (formId !== id) return;
    if (handled && discard) {
      dirty = false;
      handoffVer = undefined;
    }
    update(afterWipe(view, Boolean(handled), discard));
  }

  async function leave(choice?: LeaveChoice): Promise<boolean> {
    if (choice === 'stay') {
      update({ leaveChoices: undefined });
      return false;
    }
    const { key } = view;
    const id = formId;
    if (choice === 'discard') {
      drafts.remove(key);
      close();
      return true;
    }
    const result = await drafts.flush();
    if (id !== formId) return false;
    if (result.ok) close();
    else update(leaveFailed);
    return result.ok;
  }

  return {
    open,
    checkDraft,
    close,
    input,
    save,
    leave,
    resolveDraft,
    resolveWipe,
    retry: () => save(true),
    async retryDraftRemoval() {
      if (confirmation) {
        await removeConfirmed(confirmation);
        return;
      }
      const id = formId;
      const result = await drafts.flush();
      if (id === formId) update({ draftMessage: result.ok ? undefined : draftError });
    },
    view: () => view,
  };
}

export type GoalEditor = ReturnType<typeof createGoalEditor>;
