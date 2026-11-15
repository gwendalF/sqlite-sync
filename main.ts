import { BrowserPlatform } from "./src/platform/browser";

const p = new BrowserPlatform({ dbName: ":memory:" });
await p.start();
console.log("P ready");

const a = await p.call("query", {
  sql: "SELECT 1",
  params: [],
  isReadonly: false,
});
console.log({ a });
