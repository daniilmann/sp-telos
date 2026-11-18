import type { SaveState } from '@super-productivity/plugin-api';
import type { Plan, PlanState } from '../core/plan';
import { decodeRecord } from '../core/records';

interface Tracking {
  readonly formId: string;
  readonly generation: number;
  readonly planId: string;
}

export type SaveStatus =
  | { readonly state: 'saved'; readonly savedAt: number }
  | { readonly state: 'changed' | 'pending' | 'replaced' | 'unknown' | 'retry' | 'failed' };

interface Dependencies {
  readonly read: (keys: readonly string[]) => Promise<PlanState>;
  readonly readSaveState: (keys: string[]) => Promise<SaveState>;
  readonly now: () => number;
  readonly onStatus: (status: SaveStatus) => void;
}

interface Target {
  readonly key: string;
  readonly ver: string;
  readonly digest: string;
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function matchesVersion({ key, ver }: Target, { entries }: PlanState): boolean {
  const value = decodeRecord(key, entries[key] ?? '');
  return value.ok && value.value.ver === ver;
}

function interpret(
  targets: readonly Target[],
  reply: SaveState,
  snapshot: PlanState,
  elapsed: number,
): SaveStatus {
  if (targets.some(({ key }) => reply.keys[key]?.state === 'failed')) return { state: 'failed' };
  if (targets.some((target) => !matchesVersion(target, snapshot))) return { state: 'replaced' };
  const times = targets.flatMap(({ key, digest }) => {
    const saved = reply.keys[key];
    return saved?.state === 'saved' &&
      saved.valueSha256 === digest &&
      Number.isFinite(saved.savedAt) &&
      Math.abs(saved.savedAt) <= 8.64e15
      ? [saved.savedAt]
      : [];
  });
  if (reply.sync !== 'ok') return { state: 'retry' };
  if (times.length === targets.length) return { state: 'saved', savedAt: Math.max(...times) };
  return { state: elapsed >= 20_000 ? 'retry' : 'pending' };
}

export function createSaveStatus({ read, readSaveState, now, onStatus }: Dependencies) {
  let identity: Tracking | undefined;
  let targets: readonly Target[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let confirmed = false;
  let since = 0;

  function reset(tracking?: Tracking): void {
    clearTimeout(timer);
    timer = undefined;
    identity = tracking;
    targets = undefined;
    confirmed = false;
    since = now();
  }

  function schedule(): void {
    if (running || timer !== undefined || !identity || !targets) return;
    const current = identity;
    const expected = targets;
    timer = setTimeout(
      () => {
        timer = undefined;
        void poll(current, expected);
      },
      confirmed ? 5000 : 1000,
    );
  }

  async function poll(current: Tracking, expected: readonly Target[]): Promise<void> {
    running = true;
    let status: SaveStatus = { state: 'unknown' };
    try {
      const keys = expected.map(({ key }) => key);
      const reply = await readSaveState(keys);
      if (identity !== current) return;
      const snapshot = await read(keys);
      if (identity !== current) return;
      if (confirmed) since = now();
      status = interpret(expected, reply, snapshot, now() - since);
    } catch {
      if (confirmed) since = now();
    } finally {
      running = false;
      if (identity === current) {
        confirmed = status.state === 'saved';
        onStatus(status);
      }
      schedule();
    }
  }

  return {
    async track(tracking: Tracking, plan: Plan): Promise<void> {
      const current = { ...tracking };
      reset(current);
      onStatus({ state: 'pending' });
      try {
        const expected = await Promise.all(
          plan.writes.map(async ({ key, value }) => {
            const decoded = decodeRecord(key, value);
            if (!decoded.ok) throw new Error(decoded.reason);
            return { key, ver: decoded.value.ver, digest: await fingerprint(value) };
          }),
        );
        if (identity !== current) return;
        if (expected.length === 0) throw new Error('План не содержит записей.');
        targets = expected;
        schedule();
      } catch {
        if (identity === current) onStatus({ state: 'unknown' });
      }
    },
    invalidate(formId: string, generation: number): void {
      if (identity?.formId !== formId || identity.generation >= generation) return;
      reset();
      onStatus({ state: 'changed' });
    },
    close(formId: string): void {
      if (identity?.formId === formId) reset();
    },
  };
}

export function formatSaveTime(savedAt: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(savedAt);
}

export function saveMessage(status: SaveStatus): string {
  switch (status.state) {
    case 'saved':
      return `Сохранено в ${formatSaveTime(status.savedAt)}`;
    case 'changed':
      return 'Изменено';
    case 'pending':
      return 'Сохраняется…';
    case 'replaced':
      return 'Заменено другой версией';
    case 'retry':
      return 'Не сохранено на сервере · Повторить';
    case 'failed':
      return 'Не сохранено на этом устройстве — перезапустите приложение';
    case 'unknown':
      return 'Состояние неизвестно';
  }
}
