import { PullResponse } from "./rust/pkg/sync_sqlite";
import { SyncEngine } from "./src/client";

const mockPuller = {
  pull: async (serverVersion: number): Promise<PullResponse> => {
    return {
      server_version: 1,
      last_mutation_id: 500,
      mutations: [
        {
          op: "upsert",
          pks: ["id"],
          table: "users",
          records: [
            { id: 30, name: "Jean pierre" },
            { id: 41, name: "Crêpes" },
          ],
        },
      ],
    };
  },
};

const client = await SyncEngine.create({
  db: "test.db",
  puller: mockPuller,
  mutators: {
    addUser: async (db, { name }: { name: string }) => {
      await db.sql({
        sql: "INSERT INTO users (name) VALUES (?)",
        params: [name],
      });
    },
  },
});

console.log("ABC");

await client.untracked({
  sql: "DROP TABLE IF EXISTS users",
  params: [],
});

console.log("DEF");

await client.untracked({
  sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
  params: [],
});

console.log("Untracked done");
await client.untracked({ sql: "DELETE FROM pending_mutations", params: [] });

console.log("Pending done");
console.log("Before mutate");
await client.mutate.addUser({ name: "Gwnendal" });
console.log("Added gwendal");

const startUsers = await client.reactiveQuery(
  { sql: "SELECT * FROM users", params: [] },
  {
    onData: (data: { name: string }[]) => {
      console.log("UPDATED users:", data);
    },
    onError: (e) => {
      console.error(e);
    },
  },
);

console.log("Start users", startUsers.data);

await client.mutate.addUser({ name: "Francia" });
console.log("After mutate");
await new Promise((r) => setTimeout(r, 1000));

await client.mutate.addUser({ name: "Francia" });
console.log("Afer other mutate");
await new Promise((r) => setTimeout(r, 200));

const beforeSync = await client.untracked({
  sql: "SELECT * FROM users",
  params: [],
});
console.log("Begin sync", beforeSync);
await client.sync();

console.log("End sync");

const afterSync = await client.untracked({
  sql: "SELECT * FROM users",
  params: [],
});
console.log({ afterSync });

// await new Promise((r) => setTimeout(r, 1000));
// startUsers.unlisten();
