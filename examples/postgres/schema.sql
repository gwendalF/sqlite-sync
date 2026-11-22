-- The PostgreSQL recipe of docs/backend.md, for two tables.

-- 1. sync_xid: the transaction that wrote the row last (insert: default, update: trigger)
CREATE TABLE invoices (
  id bigint PRIMARY KEY,
  label text NOT NULL,
  issued_on date NOT NULL,
  sync_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE entries (
  id bigint PRIMARY KEY,
  invoice_id bigint NOT NULL,
  amount integer NOT NULL,
  booked_on date NOT NULL,
  sync_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX invoices_sync_xid ON invoices (sync_xid);
CREATE INDEX entries_sync_xid ON entries (sync_xid);
CREATE INDEX invoices_keyset ON invoices (issued_on DESC, id DESC);
CREATE INDEX entries_keyset ON entries (booked_on DESC, id DESC);

CREATE FUNCTION sync_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.sync_xid := pg_current_xact_id();
  RETURN NEW;
END $$;

-- 2. tombstones
CREATE TABLE sync_tombstones (
  tbl text NOT NULL,
  pk jsonb NOT NULL,
  sync_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_tombstones_sync_xid ON sync_tombstones (sync_xid);

CREATE FUNCTION sync_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_tombstones (tbl, pk) VALUES (TG_TABLE_NAME, jsonb_build_object('id', OLD.id));
  RETURN OLD;
END $$;

CREATE TRIGGER invoices_sync_touch BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION sync_touch();
CREATE TRIGGER entries_sync_touch BEFORE UPDATE ON entries FOR EACH ROW EXECUTE FUNCTION sync_touch();
CREATE TRIGGER invoices_sync_tombstone AFTER DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION sync_tombstone();
CREATE TRIGGER entries_sync_tombstone AFTER DELETE ON entries FOR EACH ROW EXECUTE FUNCTION sync_tombstone();

-- 3. how far back the tombstones go (moved by the purge)
CREATE TABLE sync_horizon (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  purged_xid xid8 NOT NULL DEFAULT '0'
);
INSERT INTO sync_horizon DEFAULT VALUES;

-- 4. last mutation applied for each client
CREATE TABLE sync_clients (client_id text PRIMARY KEY, last_mutation_id bigint NOT NULL);
