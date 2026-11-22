// A sync-sqlite backend on PostgreSQL (PGlite here), following docs/backend.md.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const TABLES = [
  { name: "invoices", select: "id, label, issued_on::text AS issued_on", key: "issued_on" },
  { name: "entries", select: "id, invoice_id, amount, booked_on::text AS booked_on", key: "booked_on" },
];

const MUTATORS = {
  renameInvoice: (tx, { id, label }) =>
    tx.query(`UPDATE invoices SET label = $1 WHERE id = $2`, [label, id]),
};

const encode = (cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decode = (cursor) => JSON.parse(Buffer.from(cursor, "base64url").toString());

export async function createServer() {
  const db = new PGlite();
  await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

  // every transaction older than this version is over
  const version = async () =>
    (await db.query(`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS v`)).rows[0].v;

  const lastMutationId = async (clientId) =>
    Number((await db.query(`SELECT last_mutation_id FROM sync_clients WHERE client_id = $1`, [clientId])).rows[0]?.last_mutation_id ?? 0);

  async function push({ client_id, mutations }) {
    for (const m of mutations) {
      await db.transaction(async (tx) => {
        const { rows } = await tx.query(`SELECT last_mutation_id FROM sync_clients WHERE client_id = $1 FOR UPDATE`, [client_id]);
        if (m.id <= Number(rows[0]?.last_mutation_id ?? 0)) return; // already applied
        await MUTATORS[m.name](tx, m.args);
        await tx.query(
          `INSERT INTO sync_clients VALUES ($1, $2) ON CONFLICT (client_id) DO UPDATE SET last_mutation_id = excluded.last_mutation_id`,
          [client_id, m.id],
        );
      });
    }
  }

  async function pull(request) {
    // read in this order: last_mutation_id, then the version, then the rows
    const lmid = await lastMutationId(request.client_id);
    if (request.cursor) return page(decode(request.cursor), request, lmid);
    if (request.known_version === 0) {
      const pos = Object.fromEntries(TABLES.map((t) => [t.name, null]));
      return page({ v0: await version(), pos, done: 0 }, request, lmid);
    }
    return changesSince(String(request.known_version), lmid);
  }

  // one bootstrap page: the current rows after the position of one table, by key
  async function page(cursor, request, lmid) {
    const limit = request.limit ?? 1000;
    const notDone = (t) => cursor.pos[t] !== "done";
    const names = TABLES.map((t) => t.name);
    const name = (request.priority ?? []).find((t) => names.includes(t) && notDone(t)) ?? names.find(notDone);
    const { select, key } = TABLES.find((t) => t.name === name);
    const after = cursor.pos[name];

    const { rows } = await db.query(
      `SELECT ${select}, ${key}::text AS sync_key FROM ${name}
       ${after ? `WHERE (${key}, id) < ($2::date, $3::bigint)` : ""}
       ORDER BY ${key} DESC, id DESC LIMIT $1`,
      after ? [limit, ...after] : [limit],
    );
    const last = rows.at(-1);
    const pos = { ...cursor.pos, [name]: rows.length < limit ? "done" : [last.sync_key, Number(last.id)] };
    const done = cursor.done + rows.length;

    const response = {
      server_version: Number(cursor.v0), // V0, never the current version
      last_mutation_id: lmid,
      mutations: rows.length
        ? [{ op: "upsert", table: name, pks: ["id"], records: rows.map(({ sync_key, ...r }) => r) }]
        : [],
    };
    if (Object.values(pos).every((p) => p === "done")) return response;
    return { ...response, cursor: encode({ ...cursor, pos, done }), progress: { done } };
  }

  // incremental: what transactions from V on wrote (>=), deletions first
  async function changesSince(v, lmid) {
    const { rows: [h] } = await db.query(`SELECT $1::text::xid8 <= purged_xid AS reset FROM sync_horizon`, [v]);
    if (h.reset) return { reset: true };

    const next = await version(); // before reading the rows
    const mutations = [];
    const { rows: deleted } = await db.query(`SELECT tbl, pk FROM sync_tombstones WHERE sync_xid >= $1::text::xid8`, [v]);
    for (const { name } of TABLES) {
      const records = deleted.filter((d) => d.tbl === name).map((d) => d.pk);
      if (records.length) mutations.push({ op: "delete", table: name, pks: ["id"], records });
    }
    for (const { name, select } of TABLES) {
      const { rows } = await db.query(`SELECT ${select} FROM ${name} WHERE sync_xid >= $1::text::xid8`, [v]);
      if (rows.length) mutations.push({ op: "upsert", table: name, pks: ["id"], records: rows });
    }
    return { server_version: Number(next), last_mutation_id: lmid, mutations };
  }

  return { db, push, pull };
}
