import { afterEach, describe, expect, it } from "vitest";
import { BrowserPlateform, type BrowserPlateformOptions } from "./browser";
import type { Plateform } from "./plateform";

const uid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SQLITE_HEADER = "SQLite format 3\0";
const SECRET = "very-secret-value-0123456789";

// sqlite-wasm-vfs sahpool layout: one pool per database in
// `sync-sqlite/<dbName>/`, one OPFS file per slot in its `.opaque/`, a
// 4096-byte header starting with the NUL-padded SQLite file name, then the
// raw database bytes.
const POOL_ROOT = "sync-sqlite";
const SAH_HEADER_SIZE = 4096;
const SAH_NAME_SIZE = 512;

const opened = new Set<Plateform>();

afterEach(async () => {
  for (const p of opened) await p.close();
  opened.clear();
});

async function open(
  dbName: string,
  o: Partial<BrowserPlateformOptions> = {},
): Promise<Plateform> {
  const p = new BrowserPlateform({ dbName, namespace: uid(), ...o });
  await p.start();
  opened.add(p);
  return p;
}

async function close(p: Plateform) {
  opened.delete(p);
  await p.close();
}

const exec = (p: Plateform, sql: string, params: unknown[] = []) =>
  p.call("query", { sql, params, isReadonly: false });

const query = async (p: Plateform, sql: string) =>
  (await p.call("query", { sql, params: [], isReadonly: true })).rows;

async function writeSecret(p: Plateform) {
  await exec(p, "CREATE TABLE secrets (v TEXT)");
  await exec(p, "INSERT INTO secrets VALUES (?)", [SECRET]);
}

/** Raw bytes of the database file as stored in OPFS (worker must be closed). */
async function rawDbFile(dbName: string): Promise<Uint8Array> {
  const root = await navigator.storage.getDirectory();
  const pool = await (
    await root.getDirectoryHandle(POOL_ROOT)
  ).getDirectoryHandle(dbName);
  const opaque = await pool.getDirectoryHandle(".opaque");
  // the terminated worker may still hold the sync access handles for a moment
  for (let attempt = 0; ; attempt++) {
    try {
      for await (const handle of (opaque as any).values() as AsyncIterable<
        FileSystemHandle
      >) {
        if (handle.kind !== "file") continue;
        const bytes = new Uint8Array(
          await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer(),
        );
        if (bytes.length <= SAH_HEADER_SIZE) continue;
        const nameBytes = bytes.subarray(0, SAH_NAME_SIZE);
        const name = new TextDecoder().decode(
          nameBytes.subarray(0, nameBytes.indexOf(0)),
        );
        if (name === dbName || name.endsWith(`/${dbName}`)) {
          return bytes.subarray(SAH_HEADER_SIZE);
        }
      }
      throw new Error(`no OPFS file for ${dbName}`);
    } catch (err) {
      if (attempt >= 20) throw err;
      await sleep(100);
    }
  }
}

const startsWithSqliteHeader = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes.subarray(0, 16)) === SQLITE_HEADER;

const containsText = (bytes: Uint8Array, text: string) => {
  const needle = new TextEncoder().encode(text);
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
};

describe("encryption", () => {
  it("without key the database file is plain SQLite", async () => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName);
    await writeSecret(p);
    await close(p);

    const raw = await rawDbFile(dbName);
    expect(startsWithSqliteHeader(raw)).toBe(true);
    expect(containsText(raw, SECRET)).toBe(true);
  });

  it("with a key the database file is encrypted and readable with the key", async () => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName, { encryptionKey: "k1" });
    await writeSecret(p);
    await close(p);

    const raw = await rawDbFile(dbName);
    expect(raw.length).toBeGreaterThan(0);
    expect(startsWithSqliteHeader(raw)).toBe(false);
    expect(containsText(raw, SECRET)).toBe(false);

    const again = await open(dbName, { encryptionKey: async () => "k1" });
    expect(await query(again, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("cannot be read without the key or with a wrong key", async () => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName, { encryptionKey: "k1" });
    await writeSecret(p);
    await close(p);

    await expect(open(dbName)).rejects.toThrow(/encrypted/);
    await expect(open(dbName, { encryptionKey: "wrong" })).rejects.toThrow(
      /encrypted/,
    );

    // the failed attempts did not damage the file
    const ok = await open(dbName, { encryptionKey: "k1" });
    expect(await query(ok, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("can encrypt an existing plain database", async () => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName);
    await writeSecret(p);
    await p.call("rekey", "k2");
    await close(p);

    const raw = await rawDbFile(dbName);
    expect(startsWithSqliteHeader(raw)).toBe(false);
    expect(containsText(raw, SECRET)).toBe(false);

    await expect(open(dbName)).rejects.toThrow(/encrypted/);
    const again = await open(dbName, { encryptionKey: "k2" });
    expect(await query(again, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("can decrypt an encrypted database", async () => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName, { encryptionKey: "k3" });
    await writeSecret(p);
    await p.call("rekey", null);
    await close(p);

    const raw = await rawDbFile(dbName);
    expect(startsWithSqliteHeader(raw)).toBe(true);
    expect(containsText(raw, SECRET)).toBe(true);

    const again = await open(dbName);
    expect(await query(again, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("can change the key", async () => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName, { encryptionKey: "old" });
    await writeSecret(p);
    await p.call("rekey", "new");
    await close(p);

    await expect(open(dbName, { encryptionKey: "old" })).rejects.toThrow(
      /encrypted/,
    );
    const again = await open(dbName, { encryptionKey: "new" });
    expect(await query(again, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("rejects a key on an in-memory database", async () => {
    await expect(
      open(":memory:", { encryptionKey: "k" }),
    ).rejects.toThrow(/in-memory/);
  });
});
