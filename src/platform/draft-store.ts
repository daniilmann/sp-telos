import { canonicalJson } from '../core/records';
import { putDraft } from './draft-store-put';

const DATABASE_NAME = 'sp-telos-drafts';
const STORE_NAME = 'drafts';
const WIPE_VERSION_KEY = 'meta:last-handled-wipe';
const FLUSH_TIMEOUT_MS = 5000;

export interface Draft {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly baseVer: string;
  readonly at: number;
}

export type DraftRead = {
  readonly value: Draft | undefined;
  readonly failed: boolean;
  readonly confirmedRemoval?: Readonly<RemovalOutcome>;
};

type Outcome<T> = { state: 'pending' | 'skipped' | T };
type RemovalOutcome = Outcome<'removed'>;

export type FlushResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'failed' | 'timeout'; readonly keys: readonly string[] };

export interface DraftStore {
  read(key: string): Promise<DraftRead>;
  list(): Promise<{ readonly keys: readonly string[]; readonly failed: boolean }>;
  write(key: string, draft: Draft): void;
  remove(key: string): void;
  claim(key: string, draft: Draft): Promise<boolean>;
  markObserved(
    key: string,
    expected: Draft,
    ver: string,
    stillCurrent: () => boolean,
  ): Readonly<Outcome<'updated'>> | undefined;
  removeConfirmed(
    key: string,
    expected: Draft,
    stillConfirmed: () => boolean,
    matchTime?: boolean,
  ): Readonly<RemovalOutcome> | undefined;
  flush(): Promise<FlushResult>;
  readWipeVersion(): Promise<string | undefined>;
  writeWipeVersion(version: string): void;
}

type Factory = Pick<IDBFactory, 'open'>;
type Value = Draft | string | undefined;

interface Pending {
  readonly value: Value;
  readonly condition: Condition | undefined;
  failed: boolean;
  running: boolean;
}

type Condition = (Guard<'removed'> | Guard<'updated'>) & {
  readonly expected: Draft;
  readonly stillCurrent: () => boolean;
  readonly matchTime: boolean;
};

type Guard<T> = { readonly success: T; readonly outcome: Outcome<T> };

export function sameDraft(observed: Draft | undefined, expected: Draft): boolean {
  return (
    observed?.baseVer === expected.baseVer &&
    canonicalJson(observed.fields) === canonicalJson(expected.fields)
  );
}

function openDatabase(factory: Factory | undefined, invalidate: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = (factory ?? indexedDB).open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Draft database open failed'));
    };
    request.onblocked = () => {
      request.onsuccess = () => {
        request.result.close();
      };
      reject(new Error('Draft database open is blocked'));
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onclose = invalidate;
      database.onversionchange = () => {
        database.close();
        invalidate();
      };
      resolve(database);
    };
  });
}

function isDraft(value: unknown): value is Draft {
  return (
    value !== null &&
    typeof value === 'object' &&
    'fields' in value &&
    value.fields !== null &&
    typeof value.fields === 'object' &&
    'baseVer' in value &&
    typeof value.baseVer === 'string' &&
    'at' in value &&
    typeof value.at === 'number'
  );
}

function mutate(
  database: IDBDatabase,
  key: string,
  { value, condition }: Pending,
  applicable: () => boolean,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    let applied = false;
    transaction.oncomplete = () => {
      resolve(applied);
    };
    // Failed requests abort the transaction by default.
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('Draft write aborted'));
    };
    const store = transaction.objectStore(STORE_NAME);
    const matches = (stored: unknown) =>
      condition !== undefined &&
      isDraft(stored) &&
      (condition.matchTime
        ? stored.at === condition.expected.at &&
          canonicalJson(stored) === canonicalJson(condition.expected)
        : sameDraft(stored, condition.expected)) &&
      applicable();
    if (value === undefined && condition) {
      const stored: IDBRequest<unknown> = store.get(key);
      stored.onsuccess = () => {
        try {
          if (!matches(stored.result)) return;
          store.delete(key);
          applied = true;
        } catch {
          transaction.abort();
        }
      };
    } else if (value === undefined) store.delete(key);
    else if (typeof value === 'string') store.put(value, key);
    else
      putDraft(transaction, store, key, value, {
        replace(stored) {
          applied = !condition || matches(stored);
          return applied;
        },
      });
  });
}

function query<T>(
  database: IDBDatabase,
  request: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('Draft read aborted'));
    };
    const result = request(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => {
      resolve(result.result);
    };
  });
}

export function createDraftStore(factory?: Factory): DraftStore {
  const pending = new Map<string, Pending>();
  const claims = new Set<string>();
  let connection: Promise<IDBDatabase> | undefined;
  let activeFlush: Promise<FlushResult> | undefined;
  let checkFlush: (() => void) | undefined;

  function database(): Promise<IDBDatabase> {
    if (connection) return connection;
    const opening = openDatabase(factory, invalidate).catch((error: unknown) => {
      invalidate();
      throw error;
    });
    connection = opening;
    return opening;

    function invalidate(): void {
      if (connection === opening) connection = undefined;
    }
  }

  async function persist(key: string, attempted: Pending): Promise<void> {
    attempted.running = true;
    const { condition } = attempted;
    const applicable = () => pending.get(key) === attempted && condition?.stillCurrent() === true;
    try {
      const connected = await database();
      // Opening the database can outlast both the confirmation and a flush deadline.
      const applied =
        (!condition || applicable()) && (await mutate(connected, key, attempted, applicable));
      if (condition) condition.outcome.state = applied ? condition.success : 'skipped';
    } catch {
      const latest = pending.get(key);
      const revoked = latest === attempted && condition?.stillCurrent() === false;
      if (condition && (revoked || latest !== attempted)) {
        condition.outcome.state = 'skipped';
      }
      if (revoked) pending.delete(key);
      else if (latest) {
        latest.running = false;
        latest.failed = true;
      }
      checkFlush?.();
      return;
    }

    const latest = pending.get(key);
    // Retire only this attempt, whether it committed or was skipped.
    if (latest === attempted) pending.delete(key);
    else if (latest) {
      latest.failed = false;
      void persist(key, latest);
    }
    checkFlush?.();
  }

  function enqueue(key: string, value: Value, condition?: Condition): void {
    const previous = pending.get(key);
    if (previous?.condition && !previous.running) previous.condition.outcome.state = 'skipped';
    const intent = {
      value,
      condition,
      failed: previous?.failed ?? false,
      running: previous?.running ?? false,
    };
    pending.set(key, intent);
    if (!intent.running) void persist(key, intent);
  }

  function flush(): Promise<FlushResult> {
    // Concurrent calls share the same deadline and retry each failed key once.
    if (activeFlush) return activeFlush;
    if (pending.size === 0) return Promise.resolve({ ok: true });

    activeFlush = new Promise((resolve) => {
      const finish = (result: FlushResult): void => {
        clearTimeout(timer);
        checkFlush = undefined;
        activeFlush = undefined;
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({ ok: false, reason: 'timeout', keys: [...pending.keys()] });
      }, FLUSH_TIMEOUT_MS);

      checkFlush = () => {
        if (pending.size === 0) {
          finish({ ok: true });
          return;
        }
        const failed = [...pending]
          .filter(([, intent]) => intent.failed && !intent.running)
          .map(([key]) => key);
        if (failed.length > 0) finish({ ok: false, reason: 'failed', keys: failed });
      };

      for (const [key, intent] of pending) {
        if (intent.failed && !intent.running) void persist(key, intent);
      }
    });
    return activeFlush;
  }

  function visibleIntent(key: string): Pending | undefined {
    const intent = pending.get(key);
    return intent?.condition?.stillCurrent() === false ? undefined : intent;
  }

  function readIntent(intent: Pending | undefined, failed = intent?.failed ?? false): DraftRead {
    const value = intent?.value;
    return {
      value: isDraft(value) ? structuredClone(value) : undefined,
      failed,
      ...(intent?.condition?.success === 'removed' && {
        confirmedRemoval: intent.condition.outcome,
      }),
    };
  }

  async function read(key: string): Promise<DraftRead> {
    const intent = visibleIntent(key);
    if (intent) return readIntent(intent);

    try {
      const value = await query<unknown>(await database(), (store) => store.get(key));
      const latest = visibleIntent(key);
      if (latest) return readIntent(latest);
      if (value === undefined || isDraft(value)) return { value, failed: false };
      return { value: undefined, failed: true };
    } catch {
      return readIntent(visibleIntent(key), true);
    }
  }

  return {
    flush,
    read,
    async list() {
      let keys: IDBValidKey[] = [];
      let failed = false;
      try {
        keys = await query(await database(), (store) => store.getAllKeys());
      } catch {
        failed = true;
      }
      const drafts = new Set(
        keys.filter((key): key is string => typeof key === 'string' && key !== WIPE_VERSION_KEY),
      );
      for (const [key, intent] of pending) {
        if (key === WIPE_VERSION_KEY || intent.condition?.stillCurrent() === false) continue;
        if (intent.value === undefined) drafts.delete(key);
        else drafts.add(key);
      }
      return { keys: [...drafts], failed };
    },
    write(key, draft) {
      if (key === WIPE_VERSION_KEY) throw new Error('Reserved draft key');
      enqueue(key, structuredClone(draft));
    },
    remove(key) {
      if (key === WIPE_VERSION_KEY) throw new Error('Reserved draft key');
      enqueue(key, undefined);
    },
    async claim(key, draft) {
      if (key === WIPE_VERSION_KEY || pending.has(key) || claims.has(key)) return false;
      claims.add(key);
      try {
        if (!(await claimDraft(database(), key, structuredClone(draft), () => !pending.has(key))))
          return false;
        return (await flush()).ok && !pending.has(key);
      } finally {
        claims.delete(key);
      }
    },
    markObserved(key, expected, ver, stillCurrent) {
      if (key === WIPE_VERSION_KEY) throw new Error('Reserved draft key');
      if (pending.has(key)) return undefined;
      const outcome: Outcome<'updated'> = { state: 'pending' };
      const original = structuredClone(expected);
      enqueue(
        key,
        { ...original, baseVer: ver },
        {
          expected: original,
          stillCurrent,
          outcome,
          success: 'updated',
          matchTime: true,
        },
      );
      return outcome;
    },
    removeConfirmed(key, expected, stillCurrent, matchTime = false) {
      if (key === WIPE_VERSION_KEY) throw new Error('Reserved draft key');
      if (pending.has(key)) return undefined;
      const outcome: RemovalOutcome = { state: 'pending' };
      enqueue(key, undefined, { expected, stillCurrent, outcome, matchTime, success: 'removed' });
      return outcome;
    },
    async readWipeVersion() {
      const intent = pending.get(WIPE_VERSION_KEY);
      if (intent && typeof intent.value === 'string') return intent.value;
      const stored = await query<unknown>(await database(), (store) => store.get(WIPE_VERSION_KEY));
      const value = pending.get(WIPE_VERSION_KEY)?.value ?? stored;
      return typeof value === 'string' ? value : undefined;
    },
    writeWipeVersion(version) {
      enqueue(WIPE_VERSION_KEY, version);
    },
  };
}

function claimDraft(
  connection: Promise<IDBDatabase>,
  key: string,
  draft: Draft,
  applicable: () => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    let transaction: IDBTransaction | undefined;
    let expired = false;
    const finish = (committed: boolean) => {
      clearTimeout(timer);
      resolve(committed);
    };
    const timer = setTimeout(() => {
      expired = true;
      try {
        transaction?.abort();
      } catch {
        // A completed transaction cannot be aborted; leave its source intact.
      }
      finish(false);
    }, FLUSH_TIMEOUT_MS);
    void connection
      .then((database) => {
        if (expired || !applicable()) {
          finish(false);
          return;
        }
        transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.oncomplete = () => {
          finish(true);
        };
        transaction.onabort = () => {
          finish(false);
        };
        putDraft(transaction, transaction.objectStore(STORE_NAME), key, draft, {
          claim: applicable,
        });
      })
      .catch(() => {
        finish(false);
      });
  });
}
