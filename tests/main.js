import { BrowserPlateform, sql, SyncEngine } from "../dist/index.js";

const output = document.querySelector("#output");
const dbName = document.querySelector("input");

let engine;
document.querySelector("#start").addEventListener("click", async () => {
  output.textContent = "Loading";
  try {
    const plateform = new BrowserPlateform({
      dbName: dbName.value,
    });
    await plateform.start();

    engine = await SyncEngine.create(plateform, {
      puller: {
        pull(version) {
          return {
            server_version: version,
            last_mutation_id: 0,
            mutations: [],
          };
        },
      },
      mutators: {
        addUser: async (handle, name) => {
          await handle.sql(sql`INSERT INTO users(name) VALUES (${name})`);
        },
      },
      migrations: [
        {
          version: 1,
          run: async (db) => {
            await db.exec("CREATE TABLE users (name)");
          },
        },
      ],
    });

    output.textContent = "ready";
  } catch (e) {
    output.textContent = `ERROR: ${e}`;
  }
});

document.querySelector("#write").addEventListener("click", async () => {
  output.textContent = "Writing";
  try {
    await engine.mutate.addUser("Jane Doe");
    output.textContent = "saved";
  } catch (e) {
    output.textContent = `ERROR: ${e}`;
  }
});

document.querySelector("#read").addEventListener("click", async () => {
  output.textContent = "Reading";
  try {
    const { rows: users } = await engine.sql(
      sql`SELECT * FROM users ORDER BY name`,
    );
    output.textContent = JSON.stringify(users);
  } catch (e) {
    output.textContent = `ERROR: ${e}`;
  }
});
