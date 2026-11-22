# sync-sqlite

Local-first SQLite for the browser, kept in sync with your server.

`sync-sqlite` runs SQLite (compiled to WebAssembly) in a Web Worker, stores the database in the
Origin Private File System (OPFS), and synchronises it with a backend you control. Writes go
through named **mutators**: they apply instantly to the local database, are queued, pushed to
your server, and replayed on top of the server state after each pull (optimistic updates with
rebase).

- **Plain SQL** – query with a `sql` tagged template, no ORM.
- **Reactive queries** – subscribe to a query and get new rows whenever a table it reads changes,
  including changes made in other tabs.
- **Multi-tab** – one tab is elected leader and owns the database; the other tabs talk to it over
  `BroadcastChannel`. Leadership moves automatically when a tab closes.
- **Optional encryption** – the database file can be encrypted (SQLite3MultipleCiphers, ChaCha20).
- **Migrations** – versioned with `PRAGMA user_version`.
- **Bring your own backend** – you implement a two-method `Syncer` (`push` / `pull`).

## Installation

```sh
npm install @gwendalf/sync-sqlite
# or
pnpm add @gwendalf/sync-sqlite
```

The package ships a `.wasm` file and a worker loaded with `new URL(..., import.meta.url)`, so use a
bundler that supports that pattern (Vite, webpack 5, …). With Vite, add
[`vite-plugin-wasm`](https://github.com/Menci/vite-plugin-wasm) (excluding the package from
dependency pre-bundling avoids broken worker/wasm URLs):

```ts
// vite.config.ts
import wasm from "vite-plugin-wasm";

export default {
  plugins: [wasm()],
  optimizeDeps: { exclude: ["@gwendalf/sync-sqlite"] },
};
```

Requires a browser with OPFS, Web Locks (`navigator.locks`) and `BroadcastChannel`.

## Quick start

```ts
import {
  BrowserPlatform,
  SyncEngine,
  defineMutators,
  sql,
  type Syncer,
} from "@gwendalf/sync-sqlite";

// 1. How the client talks to your server
const syncer: Syncer = {
  async push(request) {
    await fetch("/api/push", { method: "POST", body: JSON.stringify(request) });
  },
  async pull(request) {
    const res = await fetch("/api/pull", {
      method: "POST",
      body: JSON.stringify(request),
    });
    return res.json();
  },
};

// 2. Every write is a named mutator. It must be deterministic: it is replayed after each pull.
const mutators = defineMutators({
  addTodo: async (db, todo: { id: string; title: string }) => {
    await db.sql(
      sql`INSERT INTO todos (id, title, done) VALUES (${todo.id}, ${todo.title}, 0)`,
    );
  },
  toggleTodo: async (db, id: string) => {
    await db.sql(sql`UPDATE todos SET done = NOT done WHERE id = ${id}`);
  },
});

// 3. Open the database
const platform = new BrowserPlatform({ dbName: "my-app.sqlite" });
await platform.start();

const engine = await SyncEngine.create(platform, {
  syncer,
  mutators,
  migrations: [
    {
      version: 1,
      run: (db) =>
        db.exec(
          `CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL)`,
        ),
    },
  ],
});

// 4. Write (local first, then synced in the background)
await engine.mutate.addTodo({ id: crypto.randomUUID(), title: "Buy milk" });

// 5. Read
const { rows } = await engine.sql<{ id: string; title: string }>(
  sql`SELECT * FROM todos`,
);

// 6. Or read reactively
const { data, unlisten } = await engine.reactiveQuery<{
  id: string;
  title: string;
}>(sql`SELECT * FROM todos WHERE done = 0`, {
  onChange: (rows) => render(rows),
});
```

## API

### `new BrowserPlatform(options)` / `platform.start()`

| Option          | Type                                        | Description                                                                                                      |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `dbName`        | `string`                                    | Database file name in OPFS (`":memory:"` for an in-memory database).                                             |
| `namespace`     | `string?`                                   | Prefix of the locks and channels used between tabs. Defaults to `dbName`.                                        |
| `encryptionKey` | `string \| () => string \| Promise<string>` | Encrypts the database. Omitted: stored in plain text. All tabs must use the same key, otherwise `start()` fails. |
| `onError`       | `(err: Error) => void`                      | Called if this tab becomes leader after `start()` and cannot open the database.                                  |

`start()` resolves once a leader (this tab or another) has the database open. `close()` releases it.

### `SyncEngine.create(platform, config)`

| Config       | Type                           | Description                                                                                    |
| ------------ | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `syncer`     | `Syncer`                       | Your transport to the server (see below).                                                      |
| `mutators`   | `MutatorsConfig`               | Named write functions, usually built with `defineMutators`.                                    |
| `migrations` | `Migration[]?`                 | `{ version, run(db) }`, applied in order, tracked with `PRAGMA user_version`.                  |
| `autoSync`   | `boolean?` (default `true`)    | Run `sync()` after each mutation.                                                              |
| `onSync`     | `(result: SyncResult) => void` | Called after every sync with `{ ok: true }` or `{ ok: false, error }`. Logs errors by default. |

Instance methods:

- `engine.mutate.<name>(payload)` – runs the mutator in a transaction, records it for push, and
  notifies reactive queries of the tables it wrote.
- `engine.sql<T>(query)` – read-only query, resolves to `{ rows: T[] }`. Meant for debugging and
  one-off reads: it does not wait for a running mutation or rebase, so it may see changes that are
  rolled back afterwards. Use `reactiveQuery` to read data, and mutators to write it.
- `engine.reactiveQuery<T>(query, { onChange, onError? })` – resolves to `{ data, unlisten }`.
  `onChange` is called with fresh rows when a table read by the query changes (locally, in
  another tab, or after a pull).
- `engine.sync()` – push pending mutations, then pull and rebase.
- `engine.exportDatabase()` – the database file as a `Uint8Array`.
- `engine.listDatabases()` / `engine.deleteDatabases(names)` – manage the files in OPFS.
- `engine.close()` – remove all reactive listeners.

### Mutators

A mutator is `async (db, payload) => void`, where `db.sql(query)` runs any SQL statement. Payloads
are stored and sent to the server as JSON, so their type must be JSON-safe (checked at compile
time). For other types, give a deserializer:

```ts
defineMutators({
  setDueDate: {
    fn: async (db, p: { id: string; due: Date }) => {
      /* ... */
    },
    deserialize: (raw: any) => ({ ...raw, due: new Date(raw.due) }),
  },
});
```

Mutators are re-executed when the client rebases on new server state, so they must only depend on
their payload and the database content (no `Date.now()`, `Math.random()`, or network calls inside).

### `sql` tagged template

```ts
sql`SELECT * FROM todos WHERE id = ${id}`;
// => { sql: "SELECT * FROM todos WHERE id = ?", params: [id] }
```

Interpolated values are always bound parameters, never concatenated into the SQL.

## Server protocol

You implement `Syncer`:

```ts
interface Syncer {
  push(request: PushRequest): Promise<void>;
  pull(request: PullRequest): Promise<PullResponse>;
}
```

**Push** – the client sends its pending mutations. The server should run the matching mutator
logic for each one, in order, and remember the last processed `id` for that `client_id`.

```ts
type PushRequest = {
  client_id: string;
  mutations: { id: number; name: string; args: unknown }[];
};
```

**Pull** – the client sends the last server version it knows; the server answers with the rows
changed since, its current version, and the last mutation id it has applied for this client.

```ts
type PullRequest = { client_id: string; known_version: number };

type PullResponse = {
  server_version: number;
  last_mutation_id: number;
  mutations: {
    op: "upsert" | "delete";
    table: string;
    pks: string[]; // primary key column names
    records: Record<string, unknown>[]; // full rows for upsert, key columns for delete
  }[];
};
```

On pull, the client rolls back its local pending mutations, applies the server changes, drops the
mutations the server has acknowledged (`id <= last_mutation_id`), and replays the remaining ones on
top. Stale responses (older than the state already applied) are ignored.

## Testing

`@gwendalf/sync-sqlite/testing` provides `createTestHub()` to run the engine in Node (e.g. with Vitest) with
an in-memory database and simulated tabs:

```ts
import { createTestHub } from "@gwendalf/sync-sqlite/testing";
import { SyncEngine } from "@gwendalf/sync-sqlite";

const hub = await createTestHub();
const engine = await SyncEngine.create(hub.newTab(), {
  syncer,
  mutators,
  autoSync: false,
});
// ...
await hub.settle(); // wait for cross-tab notifications
```

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT),
at your option.
