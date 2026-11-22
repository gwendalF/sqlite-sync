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

Nothing here is specific to the bootstrap. **Any pull can be paged with the same rule**: take a
version `Vstart` before the first page, page by a stable key, end with `Vstart`, and the client pulls
again from `Vstart`. The bootstrap is the case `known_version: 0` (all rows, no tombstone); an
incremental pull too large for one response (a client offline for months, or the catch-up after a
long bootstrap) is the case `known_version: V` (rows and tombstones written since `V`). See
[Paging a pull](#paging-a-pull) for both.

The same holds for a pull in one response: the version must be taken **before** the rows are read
(or in the same snapshot). A row written meanwhile is then sent again next time, never missed.

## What the server must guarantee

1. **End a paged pull with the version taken on its first page** (`V0` for a bootstrap), never
   the current version.
2. **Answer "what changed since V"**, deletions included: keep tombstones of deleted rows. If they
   are purged and `V` is older than the purge, answer `{ reset: true }` (never for
   `known_version: 0`). Keep them much longer than a bootstrap takes.
3. **Page by key, never by `OFFSET`**:
   `WHERE (issued_on, id) < (:date, :id) ORDER BY issued_on DESC, id DESC LIMIT :limit`.
   With `OFFSET`, a row deleted from an earlier page shifts the next ones: a row that is never
   changed is skipped, and no incremental pull will ever send it. A row whose key changes during
   the paging may move across the position: it is either sent twice or sent by the next pull (it
   was written after the start version), never lost.
4. **Put everything in the cursor**: the start version and the position of each table. No session, no lock, no
   transaction held between pages. Any server instance can answer any page, the client can pause
   for days.
5. **Skip mutations already applied.** A mutation is pushed again until a pull acknowledges it, and
   during a paged pull no page acknowledges anything: compare its `id` with the last one stored for
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
CREATE INDEX invoices_keyset ON invoices (issued_on DESC, id DESC); -- pages of a bootstrap

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

### Paging a pull

The same rule for every pull too large for one response: on the first page take `Vstart` (step 3)
and put it in the cursor with the positions; each page reads by key after its position; the last
page answers `server_version: Vstart`, never the current version; the client then pulls once more
from `Vstart`. Only the rows read change:

**Bootstrap** (`known_version: 0`, `Vstart` = `V0`): every current row, by a business key (here the
newest invoices first, useful with `priority`). No tombstone: the client has nothing to delete.

The key only walks the rows: it does not need to follow the commit order, only to be a total order
(ending with the primary key, `NOT NULL` columns). That is the version's job: a row created or
changed behind the position during the paging has `sync_xid >= V0` and comes with the next pull.
Any column works, a timestamp too; one that changes often (`updated_at`) only sends more rows twice.

```sql
SELECT id, label, issued_on FROM invoices
WHERE (issued_on, id) < (:pos_date, :pos_id)          -- no WHERE on the first page
ORDER BY issued_on DESC, id DESC LIMIT :limit;
```

**Incremental pull from `V`** (`Vstart` = `V1`): the rows and tombstones of the window `[V, V1)`,
by `(sync_xid, key)`. Tombstones first, all of them, then each table:

```sql
SELECT tbl, pk, sync_xid FROM sync_tombstones
WHERE sync_xid >= :v AND sync_xid < :v1 AND (sync_xid, pk::text) > (:pos_xid, :pos_pk)
ORDER BY sync_xid, pk::text LIMIT :limit;

SELECT id, label, …, sync_xid FROM invoices
WHERE sync_xid >= :v AND sync_xid < :v1 AND (sync_xid, id) > (:pos_xid, :pos_id)
ORDER BY sync_xid, id LIMIT :limit;
```

Example: a client comes back after three months, `known_version: 5000`. The server takes
`V1 = 9000`, sends the window `[5000, 9000)` in 40 pages, the last one answering `9000`. Meanwhile
other users made 300 changes (`sync_xid >= 9000`): the next pull, from `9000`, sends them in one
response.

Why it works:

- No row enters a window: every transaction older than `Vstart` is over. A row changed or deleted
  during the paging leaves it (its new `sync_xid`, or its tombstone, is `>= Vstart`) and comes with
  the next pull. During a bootstrap, a row created or changed behind the position comes the same
  way (its `sync_xid` is `>= V0`).
- Each round only carries what changed during the previous one, so the rounds shrink until one
  response is enough.
- Tombstones go before the rows: a row deleted then created again has a tombstone older than the
  row, the delete must come first.
- Check the horizon on **each** page of an incremental pull (step 2): if tombstones of the window
  were purged meanwhile, answer `{ reset: true }`.

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

## Prerequisites and traps

A mistake here rarely fails loudly: the client just misses a row, forever, with no error. Check
this list before shipping a backend.

### Prerequisites

- **A version with "everything before V is over".** `pg_snapshot_xmin` in PostgreSQL, the event
  number with a single writer. Nothing else (see the traps below).
- **Every write path changes the version of the row**, whatever the code that writes (app, admin
  script, migration). The triggers do it for `INSERT`, `UPDATE`, `DELETE`, `COPY` and cascades;
  see [what they miss](#what-the-triggers-miss-and-the-fix) for the rest.
- **A tombstone for everything that leaves the client**, not only deletions: a primary key change,
  a row leaving the client's scope (same link).
- **A total order for the keyset**: the key ends with the primary key, and its columns are
  `NOT NULL` (a `NULL` makes the row comparison `NULL`: the row is never sent). An index matches
  `ORDER BY`.
- **The version and the rows from the same server**, the version read first. With a read replica,
  read both on the same node (see the traps).
- **Tombstones kept much longer than the longest pull**, with a horizon to answer `reset`.
- **Push applied once**: `last_mutation_id` checked and updated in the transaction of the mutation.
  A mutation that fails on the server must still move `last_mutation_id` (record the error),
  otherwise the client pushes it again forever.

### What the triggers miss, and the fix

The SQL below was checked on PGlite (PostgreSQL 17), except the per-user horizon.

**Primary key change.** The client gets the new key as an upsert and keeps the old row. Write a
tombstone for the old key (or forbid the change). **Row leaving the client's scope** (reassigned to
another user, archived and filtered out): for this client it is a deletion. Give the tombstones a
scope, and send a client only the tombstones of its scopes. One trigger covers the three cases:

```sql
ALTER TABLE sync_tombstones ADD COLUMN scope int; -- e.g. the owner

CREATE OR REPLACE FUNCTION sync_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.owner_id IS DISTINCT FROM NEW.owner_id THEN
    INSERT INTO sync_tombstones (tbl, pk, scope)
    VALUES (TG_TABLE_NAME, jsonb_build_object('id', OLD.id), OLD.owner_id);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER invoices_sync_tombstone ON invoices;
CREATE TRIGGER invoices_sync_tombstone AFTER DELETE OR UPDATE OF id, owner_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION sync_tombstone();
```

When access changes for a whole set of rows (a user removed from a project), a tombstone per row
is heavy: reset that user instead, with a per-user horizon checked like `sync_horizon`
(`sync_user_horizon(user_id, purged_xid)`, set to `pg_current_xact_id()` when access is removed).

**`TRUNCATE`** fires no row trigger, so no tombstone. A statement trigger makes every client
created before it reset (clients bootstrapped after it do not):

```sql
CREATE FUNCTION sync_truncated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sync_horizon SET purged_xid = greatest(purged_xid, pg_current_xact_id());
  RETURN NULL;
END $$;

CREATE TRIGGER invoices_sync_truncate AFTER TRUNCATE ON invoices
  FOR EACH STATEMENT EXECUTE FUNCTION sync_truncated();
```

A reset makes every client download everything again: on a synced table, prefer `DELETE` (one
tombstone per row) unless the table is emptied for good.

**`session_replication_role = replica`** (logical replication subscribers, some restore and ETL
tools) disables ordinary triggers. Mark the sync triggers `ALWAYS`:

```sql
ALTER TABLE invoices ENABLE ALWAYS TRIGGER invoices_sync_touch;
ALTER TABLE invoices ENABLE ALWAYS TRIGGER invoices_sync_tombstone;
ALTER TABLE invoices ENABLE ALWAYS TRIGGER invoices_sync_truncate;
```

On a logical replication subscriber that serves clients, this is also what you want: transaction
ids are local to each server, so `sync_xid` must be set by the server the clients pull from.

**`ALTER TABLE … ADD COLUMN … DEFAULT`** fills the column without any `UPDATE`: no trigger, no
`sync_xid` change, clients never get the new values. Same for any value that changes without a
write (computed on read, a default changed afterwards). Touch the rows, in batches to keep
transactions short, until it updates 0 rows:

```sql
-- :since = the version read just before the migration
UPDATE invoices SET currency = currency
WHERE id IN (SELECT id FROM invoices WHERE sync_xid < :since ORDER BY id LIMIT 10000);
```

The no-op `UPDATE` fires the trigger, which sets `sync_xid`. For a new column only some screens
need, a reset is simpler (`UPDATE sync_horizon SET purged_xid = pg_current_xact_id()`).

**A dump restored into another cluster** (`pg_dump`/`pg_restore`, a move to another provider)
starts again from lower transaction ids: the versions clients hold mean nothing there. Every client
must start over from `known_version: 0`, and the restored rows still carry the old cluster's
`sync_xid`. Rare, but plan it before the move. Physical replicas, failover and `pg_upgrade` keep the
ids and are not concerned (`xid8` itself never wraps: it is 64 bits, epoch included).

### Ideas that look clever and lose data

| Idea | Why it breaks | Instead |
| --- | --- | --- |
| A sequence or `max(sync_xid)` of the rows sent as the version | Transactions commit out of order: a row with an older number commits after the pull and is never sent (see [the pitfall](#pitfall-a-sequence-and-maxversion)) | `pg_snapshot_xmin(pg_current_snapshot())` |
| `updated_at` (a timestamp) as the version | Same problem: `now()` is the start of the transaction, a long one commits later with an older time. Clocks of several servers also drift | `sync_xid`. As a paging key a timestamp is fine (see [Paging a pull](#paging-a-pull)) |
| `sync_xid > V` | `V` is the oldest transaction still running: its rows have `sync_xid = V` | `>=`; duplicates are harmless |
| End a paged pull with the current version ("it is more recent") | Rows changed behind the position after the start are never sent again | The version taken on the first page |
| Take the version after reading the rows | A row committed between the read and the version is skipped | Version first |
| `OFFSET` pagination ("simpler") | A deletion in an earlier page shifts the next ones: an unchanged row is skipped forever | Keyset on a unique key |
| Paging on a key that is not unique (`issued_on` alone) | Rows with the same value at a page boundary are skipped | Add the primary key to the key |
| Version from the primary, rows from a read replica | The replica lags: a row committed before the version is not there yet, and the next pull starts after it | Same node for both |
| One transaction (`REPEATABLE READ`) held across the pages, to get a consistent snapshot | Holds `xmin` and locks for minutes, ties the client to one server, breaks on any disconnect. Not needed | Stateless pages, version kept in the cursor |
| Session or server-side state for the cursor | Lost on restart or on another instance; the client may come back days later | Everything in the cursor |
| Trusting the cursor | The client can send any cursor | Sign it (HMAC) if it holds anything sensitive, and check the permissions on every page, not only on the first one |
| A cursor format changed without care on deploy | Clients in the middle of a pull send the old format | Put a format version in the cursor; on an unknown one, answer `{ reset: true }` |
| Purging tombstones without a horizon | A client older than the purge never deletes those rows | Move `sync_horizon`, answer `reset` |
| Upserts before deletions in one response | A row deleted then created again ends up deleted on the client | Deletions first |
| Trusting `limit` | It is a hint from the client | Cap it on the server, also in bytes for large rows |
| Answering `reset` to `known_version: 0` | The client resets and asks again: loop | Never `reset` a bootstrap |

A long-running transaction on the database (even idle, `idle in transaction`) holds `xmin` back:
pulls keep sending the same rows again. Nothing is lost, but watch for them
(`idle_in_transaction_session_timeout`).

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
