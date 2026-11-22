# Example: PostgreSQL backend

The PostgreSQL recipe of [docs/backend.md](../../docs/backend.md), on
[PGlite](https://pglite.dev) (PostgreSQL in WebAssembly, no server to install).

- `schema.sql`: `sync_xid` columns and triggers, tombstones, horizon, clients.
- `server.mjs`: `push` and `pull`, with the bootstrap paged by key and `priority`.
- `demo.mjs`: bootstraps an empty client in pages of 500 rows while the server updates, deletes
  and inserts rows, then checks the client matches the server.

```sh
# at the root of the repository
pnpm build
cd examples/postgres
pnpm install
pnpm start
```
