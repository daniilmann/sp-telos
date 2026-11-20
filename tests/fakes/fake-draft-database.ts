class FakeRequest<T> extends EventTarget {
  result!: T;
  error: DOMException | null = null;
  onsuccess: EventListener | null = null;
  onerror: EventListener | null = null;
  onupgradeneeded: EventListener | null = null;

  succeed(result: T): void {
    this.result = result;
    emit(this, 'success', this.onsuccess);
  }

  fail(error: DOMException): boolean {
    this.error = error;
    return emit(this, 'error', this.onerror);
  }
}

function emit(target: EventTarget, type: string, handler: EventListener | null): boolean {
  if (handler) target.addEventListener(type, handler, { once: true });
  return target.dispatchEvent(new Event(type, { cancelable: type === 'error' }));
}

interface DatabaseData {
  storeName?: string;
  rows: Map<IDBValidKey, unknown>;
  writers: FakeTransaction[];
}

type Mutation = {
  key: IDBValidKey;
  request: FakeRequest<unknown>;
} & ({ kind: 'put' | 'add'; value: unknown } | { kind: 'delete' });

class FakeTransaction extends EventTarget {
  oncomplete: EventListener | null = null;
  onerror: EventListener | null = null;
  onabort: EventListener | null = null;
  error: DOMException | null = null;
  finished = false;
  readonly #pending: Mutation[] = [];
  readonly #staged: Mutation[] = [];
  readonly #waiting: (() => void)[] = [];
  #reads = 0;

  constructor(
    private readonly data: DatabaseData,
    private readonly mode: IDBTransactionMode,
    private readonly mutations: FakeTransaction[],
  ) {
    super();
    if (mode === 'readwrite') data.writers.push(this);
  }

  objectStore(name: string) {
    if (name !== this.data.storeName) throw new DOMException('Unknown store', 'NotFoundError');
    return {
      get: (key: IDBValidKey) => this.#read(() => this.data.rows.get(key)),
      getAll: () => this.#read(() => [...this.data.rows.values()]),
      getAllKeys: () => this.#read(() => [...this.data.rows.keys()]),
      put: (value: unknown, key: IDBValidKey) => this.#mutate({ kind: 'put', value, key }),
      add: (value: unknown, key: IDBValidKey) => this.#mutate({ kind: 'add', value, key }),
      delete: (key: IDBValidKey) => this.#mutate({ kind: 'delete', key }),
    };
  }

  #read<T>(read: () => T): FakeRequest<T> {
    this.#assertActive();
    const request = new FakeRequest<T>();
    this.#reads++;
    this.#run(() => {
      if (this.finished) return;
      this.#reads--;
      request.succeed(structuredClone(read()));
      this.#completeIfIdle();
    });
    return request;
  }

  #run(callback: () => void): void {
    if (this.mode !== 'readwrite' || this.data.writers[0] === this) queueMicrotask(callback);
    else this.#waiting.push(callback);
  }

  #completeIfIdle(): void {
    queueMicrotask(() => {
      if (!this.finished && this.#reads === 0 && !this.#pending.length && !this.#staged.length)
        this.complete();
    });
  }

  #mutate(
    change: { key: IDBValidKey } & ({ kind: 'put' | 'add'; value: unknown } | { kind: 'delete' }),
  ) {
    this.#assertActive();
    if (this.mode === 'readonly') throw new DOMException('Read-only transaction', 'ReadOnlyError');
    const request = new FakeRequest<unknown>();
    this.#pending.push({ ...structuredClone(change), request });
    this.#run(() => {
      if (!this.finished && !this.mutations.includes(this)) this.mutations.push(this);
    });
    return request;
  }

  #assertActive(): void {
    if (this.finished) throw new DOMException('Transaction finished', 'TransactionInactiveError');
  }

  #takeRequest(): Mutation {
    this.#assertActive();
    const mutation = this.#pending.shift();
    if (!mutation) throw new Error('Expected a pending mutation request');
    return mutation;
  }

  get pendingKeys(): readonly IDBValidKey[] {
    return this.#pending.map(({ key }) => key);
  }

  succeedRequest(): void {
    const mutation = this.#takeRequest();
    if (mutation.kind === 'add') {
      const latest = this.#staged
        .slice()
        .reverse()
        .find(({ key }) => key === mutation.key);
      if (latest ? latest.kind !== 'delete' : this.data.rows.has(mutation.key)) {
        const error = new DOMException('Key already exists', 'ConstraintError');
        if (mutation.request.fail(error) && emit(this, 'error', this.onerror))
          this.#abortWith(error);
        else this.#completeIfIdle();
        return;
      }
    }
    this.#staged.push(mutation);
    mutation.request.succeed(mutation.kind === 'delete' ? undefined : mutation.key);
  }

  complete(): void {
    this.#assertActive();
    if (this.#pending.length > 0 || this.#reads > 0) throw new Error('Requests are still pending');
    for (const mutation of this.#staged) {
      if (mutation.kind !== 'delete') this.data.rows.set(mutation.key, mutation.value);
      else this.data.rows.delete(mutation.key);
    }
    this.#finish();
    emit(this, 'complete', this.oncomplete);
  }

  exceedQuota(): void {
    const mutation = this.#takeRequest();
    this.error = new DOMException('Quota exhausted', 'QuotaExceededError');
    if (mutation.request.fail(this.error) && emit(this, 'error', this.onerror)) {
      this.#abortWith(this.error);
    }
  }

  abort(): void {
    this.#abortWith(new DOMException('Transaction aborted', 'AbortError'));
  }

  #abortWith(error: DOMException): void {
    this.#assertActive();
    this.#finish();
    this.error = error;
    const aborted = new DOMException('Transaction aborted', 'AbortError');
    for (const { request } of this.#pending) request.fail(aborted);
    emit(this, 'abort', this.onabort);
  }

  #finish(): void {
    this.finished = true;
    if (this.mode !== 'readwrite') return;
    const index = this.data.writers.indexOf(this);
    this.data.writers.splice(index, 1);
    if (index === 0) {
      const next = this.data.writers[0];
      if (next)
        next.#waiting.splice(0).forEach((callback) => {
          queueMicrotask(callback);
        });
    }
  }
}

class FakeConnection {
  closed = false;
  readonly transactions: FakeTransaction[] = [];

  constructor(
    private readonly data: DatabaseData,
    private readonly mutations: FakeTransaction[],
    private readonly beforeReadwrite: () => void,
  ) {}

  get objectStoreNames(): string[] & { contains: (name: string) => boolean } {
    const names = this.data.storeName === undefined ? [] : [this.data.storeName];
    return Object.assign(names, { contains: (name: string) => names.includes(name) });
  }

  createObjectStore(name: string): void {
    if (this.data.storeName !== undefined) throw new Error('Expected a single object store');
    this.data.storeName = name;
  }

  transaction(names: string | string[], mode: IDBTransactionMode = 'readonly'): FakeTransaction {
    if (this.closed) throw new DOMException('Connection closed', 'InvalidStateError');
    const [name, ...others] = typeof names === 'string' ? [names] : names;
    if (name !== this.data.storeName || others.length > 0) {
      throw new DOMException('Unknown store', 'NotFoundError');
    }
    if (mode === 'readwrite') this.beforeReadwrite();
    const transaction = new FakeTransaction(this.data, mode, this.mutations);
    this.transactions.push(transaction);
    return transaction;
  }

  close(): void {
    this.closed = true;
  }
}

export function createFakeDraftDatabase() {
  const databases = new Map<string, DatabaseData>();
  const connections: FakeConnection[] = [];
  const mutations: FakeTransaction[] = [];
  const openNames: string[] = [];
  const openFailures: DOMException[] = [];
  let beforeWrite: (() => void) | undefined;

  function beforeReadwrite(): void {
    const callback = beforeWrite;
    beforeWrite = undefined;
    callback?.();
  }

  function open(name: string): FakeRequest<FakeConnection> {
    openNames.push(name);
    const request = new FakeRequest<FakeConnection>();
    queueMicrotask(() => {
      const error = openFailures.shift();
      if (error) {
        request.fail(error);
        return;
      }
      const existing = databases.get(name);
      const data = existing ?? { rows: new Map<IDBValidKey, unknown>(), writers: [] };
      const connection = new FakeConnection(data, mutations, beforeReadwrite);
      connections.push(connection);
      if (!existing) {
        request.result = connection;
        emit(request, 'upgradeneeded', request.onupgradeneeded);
        databases.set(name, data);
      }
      request.succeed(connection);
    });
    return request;
  }

  return {
    // The fake implements the DOM calls the scenarios exercise, without browser-only members.
    factory: { open } as unknown as Pick<IDBFactory, 'open'>,
    beforeNextReadwrite(callback: () => void): void {
      beforeWrite = callback;
    },
    failNextOpen(): void {
      openFailures.push(new DOMException('Cannot open database', 'UnknownError'));
    },
    openNames,
    mutations,
    committedRows(name: string): Map<IDBValidKey, unknown> {
      return structuredClone(databases.get(name)?.rows ?? new Map<IDBValidKey, unknown>());
    },
    restart(): void {
      for (const data of databases.values()) data.writers.length = 0;
      for (const connection of connections.splice(0)) {
        connection.close();
        // An exited client loses the active requests and their staged values with no callback.
        for (const transaction of connection.transactions) transaction.finished = true;
      }
    },
  };
}
