import { canonicalJson } from '../core/records';

const DATABASE_NAME = 'sp-telos-drafts';
const STORE_NAME = 'drafts';
const WIPE_VERSION_KEY = 'meta:last-handled-wipe';
const BYTE_LIMIT = 1024 * 1024;
const FLUSH_TIMEOUT_MS = 5000;
const encoder = new TextEncoder();

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

interface RemovalOutcome {
  state: 'pending' | 'removed' | 'skipped';
}

export type FlushResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'failed' | 'timeout'; readonly keys: readonly string[] };

export interface DraftStore {
  read(key: string): Promise<DraftRead>;
  list(): Promise<{ readonly keys: readonly string[]; readonly failed: boolean }>;
  write(key: string, draft: Draft): void;
  remove(key: string): void;
  removeConfirmed(
    key: string,
    expected: Draft,
    stillConfirmed: () => boolean,
  ): Readonly<RemovalOutcome> | undefined;
  flush(): Promise<FlushResult>;
  readWipeVersion(): Promise<string | undefined>;
  writeWipeVersion(version: string): void;
}

type Factory = Pick<IDBFactory, 'open'>;
type Value = Draft | string | undefined;

interface Pending {
  readonly value: Value;
  readonly removal: ConfirmedRemoval | undefined;
  failed: boolean;
  running: boolean;
}

interface ConfirmedRemoval {
  readonly expected: Draft;
  readonly stillConfirmed: () => boolean;
  readonly outcome: RemovalOutcome;
}

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

function draftBytes(value: unknown): number {
  // The other stored value is the wipe version, a string outside the draft budget.
  return value === undefined || typeof value === 'string'
    ? 0
    : encoder.encode(JSON.stringify(value)).byteLength;
}

function putDraft(
  transaction: IDBTransaction,
  store: IDBObjectStore,
  key: string,
  draft: Draft,
): void {
  // Overlapping readwrite transactions on this store run serially, even across connections.
  const rows: IDBRequest<unknown[]> = store.getAll();
  const previous: IDBRequest<unknown> = store.get(key);
  previous.onsuccess = () => {
    try {
      const total = rows.result.reduce<number>((sum, row) => sum + draftBytes(row), 0);
      if (total - draftBytes(previous.result) + draftBytes(draft) <= BYTE_LIMIT) {
        store.put(draft, key);
        return;
      }
    } catch {
      // Serialization or a synchronous put error also leaves the intent pending.
    }
    transaction.abort();
  };
}

function mutate(
  database: IDBDatabase,
  key: string,
  { value, removal }: Pending,
  applicable: () => boolean,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    let removed = false;
    transaction.oncomplete = () => {
      resolve(removed);
    };
    // Failed requests abort the transaction by default.
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('Draft write aborted'));
    };
    const store = transaction.objectStore(STORE_NAME);
    if (removal) {
      // A separate connection can commit a new draft before this transaction starts.
      const stored: IDBRequest<unknown> = store.get(key);
      stored.onsuccess = () => {
        try {
          const observed = stored.result;
          if (!isDraft(observed) || !sameDraft(observed, removal.expected) || !applicable()) return;
          store.delete(key);
          removed = true;
        } catch {
          transaction.abort();
        }
      };
    } else if (value === undefined) store.delete(key);
    else if (typeof value === 'string') store.put(value, key);
    else putDraft(transaction, store, key, value);
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
    const { removal } = attempted;
    const applicable = () => pending.get(key) === attempted && removal?.stillConfirmed() === true;
    try {
      const connected = await database();
      // Opening the database can outlast both the confirmation and a flush deadline.
      const removed =
        (!removal || applicable()) && (await mutate(connected, key, attempted, applicable));
      if (removal) removal.outcome.state = removed ? 'removed' : 'skipped';
    } catch {
      const latest = pending.get(key);
      const revoked = latest === attempted && removal?.stillConfirmed() === false;
      if (removal && (revoked || latest !== attempted)) {
        removal.outcome.state = 'skipped';
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

  function enqueue(key: string, value: Value, removal?: ConfirmedRemoval): void {
    const previous = pending.get(key);
    if (previous?.removal && !previous.running) previous.removal.outcome.state = 'skipped';
    const intent = {
      value,
      removal,
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
    return intent?.removal?.stillConfirmed() === false ? undefined : intent;
  }

  function readIntent(intent: Pending | undefined, failed = intent?.failed ?? false): DraftRead {
    const value = intent?.value;
    return {
      value: isDraft(value) ? structuredClone(value) : undefined,
      failed,
      ...(intent?.removal && { confirmedRemoval: intent.removal.outcome }),
    };
  }

  return {
    flush,
    async read(key) {
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
    },
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
        if (key === WIPE_VERSION_KEY || intent.removal?.stillConfirmed() === false) continue;
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
    removeConfirmed(key, expected, stillConfirmed) {
      if (key === WIPE_VERSION_KEY) throw new Error('Reserved draft key');
      if (pending.has(key)) return undefined;
      const outcome: RemovalOutcome = { state: 'pending' };
      enqueue(key, undefined, { expected, stillConfirmed, outcome });
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
