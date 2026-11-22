# Writing a backend

The client talks to your server through the two methods of `Syncer` (`push`, `pull`, see the
[README](../README.md#server-protocol)). This page explains what the server must guarantee, how to
page large pulls, and gives a recipe for PostgreSQL.

Paging is optional. A server that answers every pull in one response keeps working as is: the
client only pages when the server sends a `cursor`.

The client tests run against a small in-memory backend,
[`src/test_support/paged_server.ts`](../src/test_support/paged_server.ts), which follows the rules
below. The PostgreSQL recipe runs in [examples/postgres](../examples/postgres) (on PGlite), not in
the tests.

## Protocol

```ts
type PullRequest = {
  client_id: string;
  known_version: number; // 0: the client has nothing
  cursor?: string; // the cursor of the previous page, as received
  limit?: number; // rows wanted per response, a hint
  priority?: string[]; // tables wanted first, a hint
};

type PullResponse =
  | {
      server_version: number;
      last_mutation_id: number; // last mutation applied for this client_id
      mutations: TableMutation[]; // applied in this order
      cursor?: string; // present: this response is a page, more follow
      progress?: { done: number; total?: number };
    }
  | { reset: true };

type TableMutation = {
  op: "upsert" | "delete";
  table: string;
  pks: string[];
  records: Record<string, unknown>[]; // full rows for upsert, key columns for delete
};
```

What the client does with a response:

| Response                 | Client                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| no `cursor`              | applies the rows, stores `server_version`, drops the mutations up to `last_mutation_id`. If it was the last page, pulls once more. |
| `cursor`                 | applies the rows, stores the cursor, keeps `known_version` and drops no mutation. Pulls again with the cursor at once.             |
| `{ reset: true }`        | empties the tables the server has sent rows for (not the local-only ones), keeps its pending mutations, pulls again from `known_version: 0`.                                  |

The cursor is opaque to the client: it is never parsed, only stored and sent back. It is stored in
the client database, so a reload or a network failure resumes from the last page applied. The
client applies `upsert` as `INSERT … ON CONFLICT DO UPDATE` and `delete` of a missing row is a
no-op: receiving a row twice is harmless.

`priority` is computed by the client from the tables its mounted reactive queries read (the latest
mounted query first). It is only sent on the first pull of a bootstrap (`known_version: 0`) and
with a cursor.

## What a version means

**The version the server sends means "you have everything that happened before this point",
not "your data is exactly the server state at this point".**

The server keeps no snapshot. Each page of a bootstrap reads the data as it is when the page is
asked for, so a page can hold rows newer than the start of the bootstrap. That is fine because the
version sent at the end is the one the bootstrap **started** from:

1. First page: the server notes `V0`, its current version, and puts it in the cursor.
2. Each page reads the current rows after its position.
3. Last page (no `cursor`): `server_version: V0`, **not** the current version.
4. The client pulls incrementally from `V0` and gets everything that changed during the bootstrap:
   updates, inserts and deletes. Some rows come twice, which is harmless.

Example: invoice #12 is sent at 10:01 with the value A, then changed to B on the server at 10:05,
while the bootstrap is still running. The incremental pull from `V0` (taken before 10:01) sends B.
Had the server ended the bootstrap with its current version (after 10:05), the client would keep A
forever.

The same holds for any pull: the version must be taken **before** the rows are read (or in the same
snapshot). A row written meanwhile is then sent again next time, never missed.

## What the server must guarantee

1. **End a bootstrap with `V0`**, the version it started from, never the current version.
2. **Answer "what changed since V"**, deletions included: keep tombstones of deleted rows. If they
   are purged and `V` is older than the purge, answer `{ reset: true }` (never for
   `known_version: 0`). Keep them much longer than a bootstrap takes.
3. **Page by key, never by `OFFSET`**:
   `WHERE (issued_on, id) < (:date, :id) ORDER BY issued_on DESC, id DESC LIMIT :limit`.
   With `OFFSET`, a row deleted from an earlier page shifts the next ones: a row that is never
   changed is skipped, and no incremental pull will ever send it. A row whose key changes during
   the bootstrap may move across the position: it is either sent twice or sent by the incremental
   pull (it was written after `V0`), never lost.
4. **Put everything in the cursor**: `V0` and the position of each table. No session, no lock, no
   transaction held between pages. Any server instance can answer any page, the client can pause
   for days.
5. **Skip mutations already applied.** A mutation is pushed again until a pull acknowledges it, and
   during a bootstrap no pull acknowledges anything: compare its `id` with the last one stored for
   the `client_id`.
6. **Read `last_mutation_id` first**, then the version, then the rows: a mutation acknowledged by
   the response is then in its rows.
7. **Send deletions before upserts** in an incremental response: a row deleted then created again
   has both a tombstone and a current row.

### Priority and pages shared between tables

Keep **one position per table** in the cursor, e.g.
`{ v0: 5000, pos: { invoices: ["2025-03-02", 97000], entries: null } }` (`null`: not started,
`"done"`: finished). For each page:

1. Pick the table: the first of `priority` not finished, else the first in your own order.
2. Read `limit` rows after the position of that table.
3. Update the position of that table only, copy the others.

A change of `priority` pauses a table without losing or repeating a row: its position waits in the
cursor. A page can also be shared, e.g. 80% for the first table and 20% for the next one, so
secondary tables do not wait for the main one to finish.

`progress` is optional: count the rows when the bootstrap starts (`total`) and the rows sent
(`done`), both kept in the cursor.

## PostgreSQL recipe (CRUD tables)

The version is a transaction id. Each synced row records the transaction that wrote it last;
deletions are kept in a tombstone table.

```sql
-- on each synced table
ALTER TABLE invoices
  ADD COLUMN sync_xid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX invoices_sync_xid ON invoices (sync_xid);
CREATE INDEX invoices_keyset ON invoices (issued_on DESC, id DESC); -- pages of the bootstrap

CREATE FUNCTION sync_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.sync_xid := pg_current_xact_id();
  RETURN NEW;
END $$;

CREATE TRIGGER invoices_sync_touch BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION sync_touch();

-- deletions
CREATE TABLE sync_tombstones (
  tbl text NOT NULL,
  pk jsonb NOT NULL,
  sync_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_tombstones_sync_xid ON sync_tombstones (sync_xid);
CREATE INDEX sync_tombstones_deleted_at ON sync_tombstones (deleted_at);

CREATE FUNCTION sync_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_tombstones (tbl, pk) VALUES (TG_TABLE_NAME, jsonb_build_object('id', OLD.id));
  RETURN OLD;
END $$;

CREATE TRIGGER invoices_sync_tombstone AFTER DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION sync_tombstone();

-- how far back the tombstones go
CREATE TABLE sync_horizon (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  purged_xid xid8 NOT NULL DEFAULT '0'
);
INSERT INTO sync_horizon DEFAULT VALUES;

-- last mutation applied for each client
CREATE TABLE sync_clients (client_id text PRIMARY KEY, last_mutation_id bigint NOT NULL);
```

**Version to send**: the oldest transaction still running.

```sql
SELECT pg_snapshot_xmin(pg_current_snapshot());
```

**Incremental pull from V** (`>=`, not `>`):

```sql
SELECT last_mutation_id FROM sync_clients WHERE client_id = :client_id; -- 1. first
SELECT :v <= purged_xid AS reset FROM sync_horizon;                      -- 2. too old?
SELECT pg_snapshot_xmin(pg_current_snapshot());                          -- 3. new version, before reading
SELECT tbl, pk FROM sync_tombstones WHERE sync_xid >= :v;                -- 4. deletions first
SELECT id, label, … FROM invoices WHERE sync_xid >= :v;                  -- 5. then each table
```

**Bootstrap page**: `V0` is taken (step 3) on the first page and kept in the cursor; each page runs
the keyset query of its table; the last page answers `server_version: V0`.

**Purge** the tombstones after N days and move the horizon past them:

```sql
WITH purged AS (
  DELETE FROM sync_tombstones WHERE deleted_at <= now() - interval '30 days'
  RETURNING sync_xid
)
UPDATE sync_horizon
SET purged_xid = greatest(purged_xid, (SELECT max(sync_xid) FROM purged))
WHERE EXISTS (SELECT FROM purged);
```

`xid8` is a 64-bit integer; it is sent as a JSON number, exact while it stays below 2^53 (an epoch
below 2^21). Send it as text in the cursor.

### Pitfall: a sequence and `max(version)`

Do not number writes with a sequence and send `max(version)`, neither for a bootstrap nor for an
ordinary incremental pull. Concurrent transactions commit in any order:

1. T1 writes row A and takes version 41 from the sequence, T2 writes row B and takes 42.
2. T2 commits, T1 is still running.
3. A client pulls: it sees B (42), not A (T1 is not committed), and stores `max = 42`.
4. T1 commits row A with version 41.
5. The client pulls "versions > 42": row A is never sent. The loss is permanent.

With `pg_snapshot_xmin`, step 3 answers T1's transaction id (T1 is still running), so the next pull
asks for everything from T1 on and gets row A. Some rows come twice, none is missed. A long-running
transaction holds `xmin` back and makes pulls resend more rows; it never loses one.

## Event journal with a single writer (SQLite…)

When one process writes events one after the other (a SQLite backend, an append-only log), the
sequence number of the last event is a valid version: no transaction can commit an older number
later. Store, for each event, the table, the key and the operation:

- Incremental pull from V: the events `> V` (or the rows they touched, with their current value).
  Pages are positions in the journal: the cursor holds the position and the version to end at.
- Bootstrap: read the tables by key as above, `V0` being the last event number when it starts.
- Reset: when the journal is truncated and `V` is before its start.

## Client side

- Rows of different tables arrive in different pages: a row can be there before the row it
  references. Prefer no strict foreign keys on the client, and a `LEFT JOIN` with a placeholder
  ("syncing…") in the UI. Foreign keys are only checked at the end of each page
  (`PRAGMA defer_foreign_keys`).
- `engine.syncState()` (`{ isBootstrapping, progress? }`) tells when totals and dashboards are
  provisional.
- During a bootstrap, the acknowledged mutations are replayed on top of each page until the
  incremental pull that follows the last one: a page may hold a row older than a mutation the
  server has already applied. A page read after the server applied such a mutation shows it
  twice until then (e.g. a counter incremented twice): one more reason to treat values as
  provisional while `isBootstrapping`.
