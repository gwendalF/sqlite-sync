// Bootstraps an empty client from a PostgreSQL backend, while the server keeps changing.
import { SyncEngine, sql } from "@gwendalf/sync-sqlite";
import { createTestHub } from "@gwendalf/sync-sqlite/testing";
import { createServer } from "./server.mjs";

const server = await createServer();
await server.db.exec(`
  INSERT INTO invoices (id, label, issued_on)
    SELECT i, 'invoice ' || i, date '2020-01-01' + i / 10 FROM generate_series(1, 2000) AS i;
  INSERT INTO entries (id, invoice_id, amount, booked_on)
    SELECT i, i % 2000 + 1, i, date '2020-01-01' + i / 25 FROM generate_series(1, 5000) AS i;`);

let pulls = 0;
const syncer = {
  push: (request) => server.push(request),
  async pull(request) {
    // the server changes during the bootstrap
    if (++pulls === 2) {
      await server.db.exec(`
        UPDATE invoices SET label = 'changed during the bootstrap' WHERE id = 2000; -- already sent
        DELETE FROM invoices WHERE id = 1;                                          -- not sent yet
        INSERT INTO invoices VALUES (2001, 'created during the bootstrap', '2019-01-01');`);
    }
    return server.pull(request);
  },
};

const hub = await createTestHub();
const engine = await SyncEngine.create(hub.newTab(), {
  syncer,
  autoSync: false,
  pullLimit: 500,
  mutators: {
    renameInvoice: async (db, { id, label }) => {
      await db.sql(sql`UPDATE invoices SET label = ${label} WHERE id = ${id}`);
    },
  },
  migrations: [
    {
      version: 1,
      run: (db) =>
        db.exec(`
          CREATE TABLE invoices(id INTEGER PRIMARY KEY, label TEXT, issued_on TEXT);
          CREATE TABLE entries(id INTEGER PRIMARY KEY, invoice_id INTEGER, amount INTEGER, booked_on TEXT);`),
    },
  ],
});

engine.onSyncStateChange((s) => console.log("sync state", JSON.stringify(s)));
await engine.sync();
console.log(`${pulls} pulls`);

// the local database now matches the server
const sorted = (row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
for (const table of ["invoices", "entries"]) {
  const cols = table === "invoices" ? "id, label, issued_on::text AS issued_on" : "id, invoice_id, amount, booked_on::text AS booked_on";
  const remote = (await server.db.query(`SELECT ${cols} FROM ${table} ORDER BY id`)).rows;
  const local = (await engine.sql({ sql: `SELECT * FROM ${table} ORDER BY id` })).rows;
  const same = JSON.stringify(remote.map(sorted)) === JSON.stringify(local.map(sorted));
  console.log(`${table}: ${local.length} rows, ${same ? "same as the server" : "DIFFERENT from the server"}`);
  if (!same) process.exitCode = 1;
}
