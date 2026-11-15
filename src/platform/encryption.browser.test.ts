import { describe, expect, it as itBase, vi } from "vitest";
import { BrowserPlatform, type BrowserPlatformOptions } from "./browser";
import type { Platform } from "./platform";

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

/** The platforms of a test, closed (and awaited) at its end. */
const it = itBase
  .extend("track", ({}, { onCleanup }) => {
    const opened = new Set<Platform>();
    onCleanup(async () => {
      await Promise.all([...opened].map((p) => p.close()));
    });
    return <P extends Platform>(p: P) => (opened.add(p), p);
  })
  .extend(
    "open",
    ({ track }) =>
      async (dbName: string, o: Partial<BrowserPlatformOptions> = {}) => {
        const p = new BrowserPlatform({ dbName, namespace: uid(), ...o });
        await p.start();
        return track(p);
      },
  )
  /** A tab of the same db as `dbName`, sharing its leader. */
  .extend(
    "tab",
    ({ open }) =>
      (dbName: string, o: Partial<BrowserPlatformOptions> = {}) =>
        open(dbName, { namespace: dbName, ...o }),
  );

const exec = (p: Platform, sql: string, params: unknown[] = []) =>
  p.call("query", { sql, params, isReadonly: false });

const query = async (p: Platform, sql: string) =>
  (await p.call("query", { sql, params: [], isReadonly: true })).rows;

async function writeSecret(p: Platform) {
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
      for await (const handle of (
        opaque as any
      ).values() as AsyncIterable<FileSystemHandle>) {
        if (handle.kind !== "file") continue;
        const bytes = new Uint8Array(
          await (
            await (handle as FileSystemFileHandle).getFile()
          ).arrayBuffer(),
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
  it("without key the database file is plain SQLite", async ({ open }) => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName);
    await writeSecret(p);
    await p.close();

    const raw = await rawDbFile(dbName);
    expect(startsWithSqliteHeader(raw)).toBe(true);
    expect(containsText(raw, SECRET)).toBe(true);
  });

  it("with a key the database file is encrypted and readable with the key", async ({
    open,
  }) => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName, { encryptionKey: "k1" });
    await writeSecret(p);
    await p.close();

    const raw = await rawDbFile(dbName);
    expect(raw.length).toBeGreaterThan(0);
    expect(startsWithSqliteHeader(raw)).toBe(false);
    expect(containsText(raw, SECRET)).toBe(false);

    const again = await open(dbName, { encryptionKey: async () => "k1" });
    expect(await query(again, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("cannot be read without the key or with a wrong key", async ({ open }) => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName, { encryptionKey: "k1" });
    await writeSecret(p);
    await p.close();

    await expect(open(dbName)).rejects.toThrow(/encrypted/);
    await expect(open(dbName, { encryptionKey: "wrong" })).rejects.toThrow(
      /encrypted/,
    );

    // the failed attempts did not damage the file
    const ok = await open(dbName, { encryptionKey: "k1" });
    expect(await query(ok, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("can encrypt an existing plain database", async ({ open }) => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName);
    await writeSecret(p);
    await p.call("rekey", "k2");
    await p.close();

    const raw = await rawDbFile(dbName);
    expect(startsWithSqliteHeader(raw)).toBe(false);
    expect(containsText(raw, SECRET)).toBe(false);

    await expect(open(dbName)).rejects.toThrow(/encrypted/);
    const again = await open(dbName, { encryptionKey: "k2" });
    expect(await query(again, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("can decrypt an encrypted database", async ({ open }) => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName, { encryptionKey: "k3" });
    await writeSecret(p);
    await p.call("rekey", null);
    await p.close();

    const raw = await rawDbFile(dbName);
    expect(startsWithSqliteHeader(raw)).toBe(true);
    expect(containsText(raw, SECRET)).toBe(true);

    const again = await open(dbName);
    expect(await query(again, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("can change the key", async ({ open }) => {
    const dbName = `${uid()}.db`;
    const p = await open(dbName, { encryptionKey: "old" });
    await writeSecret(p);
    await p.call("rekey", "new");
    await p.close();

    await expect(open(dbName, { encryptionKey: "old" })).rejects.toThrow(
      /encrypted/,
    );
    const again = await open(dbName, { encryptionKey: "new" });
    expect(await query(again, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("rejects a key on an in-memory database", async ({ open }) => {
    await expect(open(":memory:", { encryptionKey: "k" })).rejects.toThrow(
      /in-memory/,
    );
  });
});

describe("several tabs", () => {
  const leaderHeld = async (dbName: string) =>
    (await navigator.locks.query()).held?.some(
      (l) => l.name === `${dbName}:leader`,
    );

  it("a tab with the key joins the leader", async ({ tab }) => {
    const dbName = `${uid()}.db`;
    const leader = await tab(dbName, { encryptionKey: "k1" });
    await writeSecret(leader);

    const follower = await tab(dbName, { encryptionKey: async () => "k1" });
    expect(await query(follower, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("a tab with a wrong key or without key cannot join the leader", async ({
    tab,
  }) => {
    const dbName = `${uid()}.db`;
    const leader = await tab(dbName, { encryptionKey: "k1" });
    await writeSecret(leader);

    await expect(tab(dbName, { encryptionKey: "wrong" })).rejects.toThrow(
      /encrypted/,
    );
    await expect(tab(dbName)).rejects.toThrow(/encrypted/);
    expect(await query(leader, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("a tab with a key cannot join a plain leader", async ({ tab }) => {
    const dbName = `${uid()}.db`;
    await tab(dbName);

    await expect(tab(dbName, { encryptionKey: "k1" })).rejects.toThrow(
      /encrypted/,
    );
  });

  it("the leader start fails on a wrong key even if a tab joins meanwhile", async ({
    tab,
    track,
  }) => {
    const dbName = `${uid()}.db`;
    await (await tab(dbName, { encryptionKey: "k1" })).close();

    const leader = track(
      new BrowserPlatform({ dbName, encryptionKey: "wrong" }),
    );
    const started = leader.start();
    // the leader holds the lock, its worker is still opening the db
    await vi.waitUntil(() => leaderHeld(dbName), { interval: 1 });
    const joining = tab(dbName, { encryptionKey: "k1" });

    await expect(started).rejects.toThrow(/encrypted/);
    // the joining tab takes the lead and opens the db with the right key
    await expect(joining).resolves.toBeDefined();
  });

  it("a tab joining while the leader opens the db gets answers", async ({
    tab,
    track,
  }) => {
    const dbName = `${uid()}.db`;
    const leader = track(new BrowserPlatform({ dbName, encryptionKey: "k1" }));
    const started = leader.start();
    await vi.waitUntil(() => leaderHeld(dbName), { interval: 1 });
    const follower = await tab(dbName, { encryptionKey: "k1" });

    await started;
    await writeSecret(follower);
    expect(await query(leader, "SELECT v FROM secrets")).toEqual([SECRET]);
  });

  it("a tab taking the lead that cannot open the db rejects its calls", async ({
    tab,
  }) => {
    const dbName = `${uid()}.db`;
    const leader = await tab(dbName, { encryptionKey: "k1" });
    const onError = vi.fn();
    const follower = await tab(dbName, { encryptionKey: "k1", onError });
    await writeSecret(leader);
    // the key of the follower does not open the db anymore
    await leader.call("rekey", "k2");
    await leader.close();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0].message).toMatch(/encrypted/);
    await expect(query(follower, "SELECT 1")).rejects.toThrow(/encrypted/);
  });
});
