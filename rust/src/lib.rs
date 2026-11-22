use std::{collections::BTreeMap, pin::Pin, ptr::NonNull};

use rusqlite::{
    params,
    session::{invert_strm, ConflictAction, ConflictType, Session},
    types::ValueRef,
};
use serde::{Deserialize, Serialize};
use sqlite_wasm_rs::{vfs::VfsFilesManager, WasmOsCallback};
use sqlite_wasm_vfs::sahpool::OpfsSAHPoolCfgBuilder;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::WasmError::Sql;

pub enum WasmError {
    Sql(String),
    Serde(String),
    Other(String),
}

impl std::fmt::Display for WasmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WasmError::Sql(s) | WasmError::Serde(s) | WasmError::Other(s) => f.write_str(s),
        }
    }
}

impl From<WasmError> for wasm_bindgen::JsValue {
    fn from(value: WasmError) -> Self {
        match value {
            WasmError::Sql(s) => wasm_bindgen::JsValue::from_str(&s),
            WasmError::Other(s) => wasm_bindgen::JsValue::from_str(&s),
            WasmError::Serde(s) => wasm_bindgen::JsValue::from_str(&s),
        }
    }
}

impl From<rusqlite::Error> for WasmError {
    fn from(value: rusqlite::Error) -> Self {
        WasmError::Sql(value.to_string())
    }
}

impl From<sqlite_wasm_vfs::sahpool::OpfsSAHError> for WasmError {
    fn from(value: sqlite_wasm_vfs::sahpool::OpfsSAHError) -> Self {
        WasmError::Sql(value.to_string())
    }
}

impl From<serde_wasm_bindgen::Error> for WasmError {
    fn from(value: serde_wasm_bindgen::Error) -> Self {
        WasmError::Serde(value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, WasmError>;

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &'static str = include_str!("types.ts");

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "SqlQuery")]
    pub type JsSqlQuery;

    #[wasm_bindgen(typescript_type = "SqlResult")]
    pub type JsSqlResult;

    #[wasm_bindgen(typescript_type = "PullRequest")]
    pub type JsPullRequest;

    #[wasm_bindgen(typescript_type = "PullResponse")]
    pub type JsPullResponse;

    #[wasm_bindgen(typescript_type = "LocalMutations")]
    pub type JsLocalMutations;

    #[wasm_bindgen(typescript_type = "PushRequest")]
    pub type JsPushRequest;

    #[wasm_bindgen(typescript_type = "SyncState")]
    pub type JsSyncState;

    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[allow(unused_macros)]
macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

const ENCRYPTED_VFS: &str = "multipleciphers-opfs-sahpool";

/// OPFS directory holding one SAH pool per database.
const POOL_ROOT: &str = "sync-sqlite";

/// A pool locks every file of its directory for its worker, so each database
/// gets its own: two tabs can open two databases at the same time.
fn pool_directory(db_path: &str) -> Result<String> {
    let name = db_path.trim_start_matches('/');
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(WasmError::Other(format!(
            "invalid database name {db_path:?}: expected a file name without '/'"
        )));
    }
    Ok(format!("{POOL_ROOT}/{name}"))
}

/// An encrypted database opened with no key or a wrong key only fails on the
/// first page read (SQLITE_NOTADB), so force one and report it clearly.
fn check_readable(conn: &rusqlite::Connection) -> Result<()> {
    match conn.query_row("SELECT count(*) FROM sqlite_schema", (), |_| Ok(())) {
        Ok(()) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::NotADatabase =>
        {
            Err(WasmError::Other(String::from(
                "cannot read database: it is encrypted and the key is missing or invalid",
            )))
        }
        Err(e) => Err(e.into()),
    }
}

#[derive(Deserialize, Debug)]
pub struct SqlQuery {
    pub sql: String,
    pub params: Vec<serde_json::Value>,
    pub is_readonly: bool,
}

#[wasm_bindgen]
pub struct SqliteEngine {
    client_id: String,
    connection: Pin<Box<rusqlite::Connection>>,
    pool: Option<sqlite_wasm_vfs::sahpool::OpfsSAHPoolUtil>,
    /// Version of the last complete pull, opaque. `None`: nothing pulled yet.
    version: Option<String>,
    /// Cursor of the partial pull in progress, as last committed.
    cursor: Option<String>,
    push_state: PushState,
}

/// Keys of the `config` table holding the pull state.
const VERSION: &str = "version";
const PULL_CURSOR: &str = "pull_cursor";
const PULL_PROGRESS: &str = "pull_progress";
/// Set from the first partial page until the incremental pull that follows the last one.
const BOOTSTRAPPING: &str = "bootstrapping";

/// Tables the server has written to (JSON array): what a reset empties, local tables are kept.
const SYNCED_TABLES: &str = "synced_tables";

#[derive(Serialize)]
pub struct SqlOutput {
    rows: Vec<serde_json::Value>,
    is_readonly: bool,
}

#[derive(Serialize)]
pub struct PullRequest {
    client_id: String,
    /// Sent as `null` when the client has nothing yet.
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
}

/// The part of the request a response answers, to detect stale responses.
#[derive(Deserialize)]
pub struct PullRequestEcho {
    version: Option<String>,
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PullResponse {
    Changes {
        version: String,
        last_mutation_id: usize,
        mutations: Vec<TableMutation>,
        /// Present on a partial response: pull again with it.
        cursor: Option<String>,
        progress: Option<serde_json::Value>,
    },
    /// The server cannot answer from `version`: drop the replicated data.
    Reset,
}

#[derive(Serialize)]
pub struct SyncState {
    is_bootstrapping: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct LocalMutation {
    id: usize,
    name: String,
    args: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct PushRequest {
    client_id: String,
    mutations: Vec<LocalMutation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MutationOp {
    Upsert,
    Delete,
}

#[derive(Deserialize)]
pub struct TableMutation {
    op: MutationOp,
    table: String,
    pks: Vec<String>,
    records: Vec<BTreeMap<String, serde_json::Value>>,
}

#[derive(Clone, Debug)]
pub struct Mutation {
    id: usize,
    name: String,
    args: Option<serde_json::Value>,
    changeset: Vec<u8>,
}

enum PushState {
    Idle,
    InProgress { session: NonNull<Session<'static>> },
}

struct RollbackErr<'a> {
    reason: String,
    conn: &'a rusqlite::Connection,
}

impl<'a> Drop for RollbackErr<'a> {
    fn drop(&mut self) {
        let _ = self.conn.execute("ROLLBACK", ());
    }
}

impl<'a> From<RollbackErr<'a>> for WasmError {
    fn from(value: RollbackErr<'a>) -> Self {
        Sql(value.reason.clone())
    }
}

#[wasm_bindgen]
impl SqliteEngine {
    #[wasm_bindgen]
    pub async fn create(db_path: &str, encryption_key: Option<String>) -> Result<Self> {
        let encryption_key = encryption_key.filter(|k| !k.is_empty());
        let in_memory = db_path.contains(":memory:");

        let pool = if !in_memory {
            let cfg = OpfsSAHPoolCfgBuilder::new()
                .directory(&pool_directory(db_path)?)
                .build();
            let pool = sqlite_wasm_vfs::sahpool::install::<WasmOsCallback>(&cfg, true).await?;
            Some(pool)
        } else {
            None
        };

        let conn = if in_memory {
            if encryption_key.is_some() {
                return Err(WasmError::Other(String::from(
                    "encryption is not supported for in-memory databases",
                )));
            }
            rusqlite::Connection::open(db_path)?
        } else {
            // sqlite3mc only wraps the VFS that was the default when SQLite was
            // initialised (the memory VFS). Naming "multipleciphers-<vfs>" makes
            // sqlite3mc create the encryption shim around opfs-sahpool on open.
            // Without a key the shim is a pass-through and the file stays plain.
            rusqlite::Connection::open_with_flags_and_vfs(
                db_path,
                rusqlite::OpenFlags::default(),
                ENCRYPTED_VFS,
            )?
        };

        if let Some(key) = &encryption_key {
            // must be the very first statement on the connection
            conn.pragma_update(None, "key", key)?;
        }
        check_readable(&conn)?;

        conn.execute_batch(
            "
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value NOT NULL);
        CREATE TABLE IF NOT EXISTS pending_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, args BLOB, changeset BLOB NOT NULL);",
        )?;

        let client_id = match conn.query_one(
            "SELECT value FROM config WHERE key = 'client_id'",
            (),
            |row| row.get(0),
        ) {
            Ok(s) => s,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                let client_id = uuid::Uuid::now_v7().to_string();
                conn.execute(
                    "INSERT INTO config (key, value) VALUES (?,?)",
                    params!["client_id", client_id],
                )?;
                client_id
            }
            err => err?,
        };

        let (version, cursor) = Self::read_pull_state(&conn)?;

        Ok(SqliteEngine {
            client_id,
            connection: Box::pin(conn),
            pool,
            version,
            cursor,
            push_state: PushState::Idle,
        })
    }

    fn read_pull_state(
        conn: &rusqlite::Connection,
    ) -> rusqlite::Result<(Option<String>, Option<String>)> {
        let version = Self::config_get::<String>(conn, VERSION)?;
        let cursor = Self::config_get::<String>(conn, PULL_CURSOR)?;
        Ok((version, cursor))
    }

    fn config_get<T: rusqlite::types::FromSql>(
        conn: &rusqlite::Connection,
        key: &str,
    ) -> rusqlite::Result<Option<T>> {
        let mut stmt = conn.prepare_cached("SELECT value FROM config WHERE key = ?")?;
        match stmt.query_row((key,), |row| row.get(0)) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `None` deletes the key.
    fn config_set(&self, key: &str, value: Option<rusqlite::types::Value>) -> rusqlite::Result<()> {
        match value {
            Some(value) => {
                let mut stmt = self.connection.prepare_cached(
                    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                )?;
                stmt.execute(params![key, value])?;
            }
            None => {
                let mut stmt = self
                    .connection
                    .prepare_cached("DELETE FROM config WHERE key = ?")?;
                stmt.execute((key,))?;
            }
        }
        Ok(())
    }

    #[wasm_bindgen]
    pub fn free(self) {
        drop(self);
    }

    #[wasm_bindgen]
    pub fn sql_exec(&self, query: JsSqlQuery) -> Result<JsSqlResult> {
        let query: SqlQuery = serde_wasm_bindgen::from_value(query.into())?;
        let mut stmt = self.connection.prepare_cached(&query.sql)?;
        let is_readonly = stmt.readonly();
        if query.is_readonly && !is_readonly {
            return Err(WasmError::Other(String::from("operation is not read only")));
        }

        let cols: Vec<_> = stmt.column_names().map(|c| c.to_string()).collect();

        let rows: Vec<_> = stmt
            .query_map(
                rusqlite::params_from_iter(query.params.into_iter().map(Self::to_rusqlite)),
                |row| {
                    let n = cols.len();
                    if n == 1 {
                        let val = self.rusqlite_to_serde(row, 0)?;
                        return Ok(val);
                    }

                    let mut map = serde_json::Map::new();
                    for (i, col) in cols.iter().enumerate() {
                        let val = self.rusqlite_to_serde(row, i)?;
                        map.insert(col.to_owned(), val);
                    }

                    Ok(serde_json::Value::Object(map))
                },
            )?
            .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;

        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        let result = SqlOutput { rows, is_readonly }.serialize(&serializer)?;
        Ok(result.into())
    }

    #[wasm_bindgen]
    pub fn exec_migration(&mut self, batch: &str, user_version: u32) -> Result<()> {
        let tx = self.connection.transaction()?;
        tx.execute_batch(batch)?;
        tx.pragma_update(None, "user_version", user_version)?;
        tx.commit()?;
        Ok(())
    }

    #[wasm_bindgen]
    pub fn push_request(&self) -> Result<JsPushRequest> {
        let mut stmt = self
            .connection
            .prepare_cached("SELECT id, name, json(args) FROM pending_mutations ORDER BY id")?;

        let mutations = stmt
            .query_map((), |row| {
                let args = row.get_ref(2)?.as_str_or_null()?;
                let value = match args {
                    Some(args) => {
                        let value = serde_json::from_str(args).map_err(|e| {
                            rusqlite::Error::InvalidColumnType(
                                1,
                                e.to_string(),
                                rusqlite::types::Type::Text,
                            )
                        })?;
                        Some(value)
                    }
                    None => None,
                };
                Ok(LocalMutation {
                    id: row.get::<_, i64>(0)? as usize,
                    name: row.get(1)?,
                    args: value,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let request = PushRequest {
            client_id: self.client_id.clone(),
            mutations,
        };
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        let js_request = request.serialize(&serializer)?;

        Ok(JsPushRequest { obj: js_request })
    }

    fn rusqlite_to_serde<'a>(
        &self,
        row: &rusqlite::Row<'a>,
        col: usize,
    ) -> std::result::Result<serde_json::Value, rusqlite::Error> {
        let val = match row.get_ref(col)? {
            ValueRef::Null => serde_json::Value::Null,
            ValueRef::Integer(n) => serde_json::Value::from(n),
            ValueRef::Real(f) => serde_json::Value::from(f),
            ValueRef::Text(s) => serde_json::Value::from(String::from_utf8_lossy(s)),
            ValueRef::Blob(b) => serde_json::Value::from(b),
        };
        Ok(val)
    }

    fn to_rusqlite(serde_value: serde_json::Value) -> rusqlite::types::Value {
        match serde_value {
            serde_json::Value::Null => rusqlite::types::Value::Null,
            serde_json::Value::Bool(true) => rusqlite::types::Value::Integer(1),
            serde_json::Value::Bool(false) => rusqlite::types::Value::Integer(0),
            serde_json::Value::Number(number) => {
                if number.is_i64() {
                    return rusqlite::types::Value::Integer(number.as_i64().unwrap());
                }

                if number.is_u64() {
                    return rusqlite::types::Value::Integer(number.as_u64().unwrap() as i64);
                }

                rusqlite::types::Value::Real(number.as_f64().unwrap())
            }
            serde_json::Value::String(s) => rusqlite::types::Value::Text(s),
            _ => {
                let s = serde_json::to_string(&serde_value).unwrap();
                rusqlite::types::Value::Text(s)
            }
        }
    }

    #[wasm_bindgen]
    pub fn begin_pull(&mut self) -> Result<JsPullRequest> {
        let serializer = serde_wasm_bindgen::Serializer::new()
            .serialize_maps_as_objects(true)
            .serialize_missing_as_null(true);
        let request = PullRequest {
            version: self.version.clone(),
            client_id: self.client_id.clone(),
            cursor: self.cursor.clone(),
        };

        let js_req = request.serialize(&serializer)?;
        Ok(js_req.into())
    }

    /// Pulls can run concurrently (several tabs, or several syncs of the same tab), so their
    /// responses may arrive out of order. A response answering a request made on a state
    /// that has moved since (another version or cursor) is stale and ignored: nothing is
    /// done and `None` is returned, the caller must not call `end_rebasing`. Versions are
    /// opaque, never compared: the next pull gets what an ignored response held.
    ///
    /// A response with a `cursor` is one page of a partial pull: its rows are applied but
    /// `version` is kept, the cursor is stored to resume from it. Acknowledged
    /// mutations are only purged by a pull that is not part of a partial pull: a page may
    /// hold a row older than a mutation the server has already applied.
    #[wasm_bindgen]
    pub fn start_rebasing(
        &mut self,
        request: JsPullRequest,
        response: JsPullResponse,
    ) -> Result<Option<JsLocalMutations>> {
        let request: PullRequestEcho = serde_wasm_bindgen::from_value(request.into())?;
        let response: PullResponse = serde_wasm_bindgen::from_value(response.into())?;
        if request.version != self.version || request.cursor != self.cursor {
            return Ok(None);
        }

        self.connection.prepare_cached("BEGIN")?.execute(())?;
        let mutations = self
            .rebase_on(&request.cursor, response)
            .map_err(|e| RollbackErr {
                reason: e.to_string(),
                conn: &self.connection,
            })?;

        let response: Vec<_> = mutations
            .into_iter()
            .map(|m| LocalMutation {
                id: m.id,
                name: m.name,
                args: m.args,
            })
            .collect();
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        let response = response.serialize(&serializer).map_err(|e| RollbackErr {
            reason: e.to_string(),
            conn: &self.connection,
        })?;

        Ok(Some(response.into()))
    }

    /// Reverts the pending mutations and writes the response, in the open transaction.
    /// Returns the mutations to replay.
    fn rebase_on(&self, cursor: &Option<String>, response: PullResponse) -> Result<Vec<Mutation>> {
        use rusqlite::types::Value;

        // a page may hold a row before the row it references
        self.connection
            .execute("PRAGMA defer_foreign_keys = ON", ())?;

        let PullResponse::Changes {
            version,
            last_mutation_id,
            mutations: changes,
            cursor: next_cursor,
            progress,
        } = response
        else {
            // no purge: the pending mutations are replayed on the empty tables
            let mutations = self.revert_changesets(0)?;
            self.clear_replicated_tables()?;
            self.config_set(VERSION, None)?;
            self.config_set(PULL_CURSOR, None)?;
            self.config_set(PULL_PROGRESS, None)?;
            self.config_set(BOOTSTRAPPING, None)?;
            return Ok(mutations);
        };

        let purge = cursor.is_none() && next_cursor.is_none();
        let last_mutation_id = if purge { last_mutation_id } else { 0 };
        let mutations = self.revert_changesets(last_mutation_id)?;

        self.record_synced_tables(&changes)?;
        self.apply_server_state(changes)?;

        match next_cursor {
            Some(next_cursor) => {
                self.config_set(PULL_CURSOR, Some(Value::Text(next_cursor)))?;
                self.config_set(BOOTSTRAPPING, Some(Value::Integer(1)))?;
            }
            None => {
                self.config_set(PULL_CURSOR, None)?;
                self.config_set(VERSION, Some(Value::Text(version)))?;
            }
        }

        if purge {
            self.config_set(PULL_PROGRESS, None)?;
            self.config_set(BOOTSTRAPPING, None)?;
            let mut stmt = self
                .connection
                .prepare_cached("DELETE FROM pending_mutations WHERE id <= ?")?;
            stmt.execute((last_mutation_id as i64,))?;
        } else if let Some(progress) = progress {
            let progress =
                serde_json::to_string(&progress).map_err(|e| WasmError::Serde(e.to_string()))?;
            self.config_set(PULL_PROGRESS, Some(Value::Text(progress)))?;
        }

        Ok(mutations)
    }

    fn synced_tables(&self) -> Result<std::collections::BTreeSet<String>> {
        match Self::config_get::<String>(&self.connection, SYNCED_TABLES)? {
            Some(json) => serde_json::from_str(&json).map_err(|e| WasmError::Serde(e.to_string())),
            None => Ok(Default::default()),
        }
    }

    fn record_synced_tables(&self, mutations: &[TableMutation]) -> Result<()> {
        let mut tables = self.synced_tables()?;
        let before = tables.len();
        tables.extend(mutations.iter().map(|m| m.table.clone()));
        if tables.len() != before {
            let json =
                serde_json::to_string(&tables).map_err(|e| WasmError::Serde(e.to_string()))?;
            self.config_set(SYNCED_TABLES, Some(rusqlite::types::Value::Text(json)))?;
        }
        Ok(())
    }

    /// Empties the tables the server has written to. Local-only tables are kept.
    fn clear_replicated_tables(&self) -> Result<()> {
        let mut sql = String::new();
        for table in self.synced_tables()? {
            sql.clear();
            sql.push_str("DELETE FROM ");
            Self::push_ident(&mut sql, &table);
            self.connection.execute(&sql, ())?;
        }
        Ok(())
    }

    #[wasm_bindgen]
    pub fn end_rebasing(&mut self) -> Result<()> {
        self.connection.execute("COMMIT", ())?;
        let (version, cursor) = Self::read_pull_state(&self.connection)?;
        self.version = version;
        self.cursor = cursor;
        Ok(())
    }

    #[wasm_bindgen]
    pub fn sync_state(&self) -> Result<JsSyncState> {
        let is_bootstrapping = self.cursor.is_some()
            || Self::config_get::<i64>(&self.connection, BOOTSTRAPPING)?.is_some();
        let progress = match Self::config_get::<String>(&self.connection, PULL_PROGRESS)? {
            Some(p) => Some(serde_json::from_str(&p).map_err(|e| WasmError::Serde(e.to_string()))?),
            None => None,
        };
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        let state = SyncState {
            is_bootstrapping,
            progress,
        }
        .serialize(&serializer)?;
        Ok(state.into())
    }

    #[wasm_bindgen]
    pub fn start_mutate(&mut self) -> Result<()> {
        if matches!(self.push_state, PushState::InProgress { .. }) {
            return Err(WasmError::Other(String::from(
                "capture already in progress",
            )));
        }
        self.connection.execute("BEGIN", ())?;
        if let Err(e) = self.open_session() {
            let _ = self.connection.execute("ROLLBACK", ());
            return Err(e);
        }
        Ok(())
    }

    /// Starts recording the changes of a replayed mutation. No BEGIN: replays run
    /// inside the transaction opened by `start_rebasing`.
    #[wasm_bindgen]
    pub fn start_capture(&mut self) -> Result<()> {
        if matches!(self.push_state, PushState::InProgress { .. }) {
            return Err(WasmError::Other(String::from(
                "capture already in progress",
            )));
        }
        self.open_session()
    }

    /// Stores the changeset of a replayed mutation, computed on the new base, so the
    /// next rebase reverts what the replay actually did and not what the original
    /// run did on a base that no longer exists.
    #[wasm_bindgen]
    pub fn end_replay(&mut self, id: usize) -> Result<()> {
        let inverted_changeset = self.close_session()?;
        let mut stmt = self
            .connection
            .prepare_cached("UPDATE pending_mutations SET changeset = ? WHERE id = ?")?;
        stmt.execute(params![inverted_changeset, id as i64])?;
        Ok(())
    }

    /// Aborts the current mutation or rebase: frees the session if any and rolls back
    /// if a transaction is open. Safe to call in any state.
    #[wasm_bindgen]
    pub fn rollback(&mut self) -> Result<()> {
        drop(self.take_session());
        if !self.connection.is_autocommit() {
            self.connection.execute("ROLLBACK", ())?;
        }
        Ok(())
    }

    #[wasm_bindgen]
    pub fn begin(&self) -> Result<()> {
        self.connection.execute("BEGIN", ())?;
        Ok(())
    }

    #[wasm_bindgen]
    pub fn commit(&self) -> Result<()> {
        self.connection.execute("COMMIT", ())?;
        Ok(())
    }

    #[wasm_bindgen]
    pub fn end_mutate(&mut self, name: &str, args: Option<String>) -> Result<()> {
        let inverted_changeset = self.close_session()?;
        let mut stmt = self.connection.prepare_cached(
            "INSERT INTO pending_mutations (name, args, changeset) VALUES (?, jsonb(?), ?)",
        )?;
        stmt.execute(params![name, args, inverted_changeset])?;
        self.connection.execute("COMMIT", ())?;
        Ok(())
    }

    #[wasm_bindgen]
    pub fn export_db(&mut self) -> Result<Vec<u8>> {
        let data = self.connection.serialize("main")?;
        Ok(data.to_vec())
    }

    #[wasm_bindgen]
    pub fn rekey(&self, encryption_key: Option<String>) -> Result<()> {
        if self.pool.is_none() {
            return Err(WasmError::Other(String::from(
                "encryption is not supported for in-memory databases",
            )));
        }
        let key = encryption_key.unwrap_or_default();
        self.connection.pragma_update(None, "rekey", key)?;
        Ok(())
    }

    #[wasm_bindgen]
    pub fn list_databases(&self) -> Result<Vec<String>> {
        match &self.pool {
            None => Ok(vec![]),
            Some(p) => Ok(p.names()?),
        }
    }

    #[wasm_bindgen]
    pub fn delete_databases(&self, databases: Vec<String>) -> Result<()> {
        match &self.pool {
            None => Err(WasmError::Other(String::from("no sah pool"))),
            Some(p) => {
                for name in databases {
                    p.remove(&name)?;
                }
                Ok(())
            }
        }
    }

    fn open_session(&mut self) -> Result<()> {
        let mut session = Session::new(&self.connection)?;
        // Shadow tables (FTS5, R*Tree...) are written by their virtual table, itself
        // fed by triggers on real tables: replaying the real tables rebuilds them.
        let shadow_tables = self.shadow_tables()?;
        session.table_filter(Some(move |table: &str| !shadow_tables.contains(table)));
        session.attach::<&str>(None)?;

        // we can assume static lifetime because connection is held by the struct and pin
        // clippy warn but we extend the lifetime so the as is necessary
        #[allow(clippy::unnecessary_cast)]
        let session = Box::into_raw(Box::new(session)) as *mut Session<'static>;

        let session = NonNull::new(session).unwrap();
        self.push_state = PushState::InProgress { session };
        Ok(())
    }

    /// Takes the session out of `push_state` first, so an error later on can never
    /// leave a dangling pointer behind.
    fn take_session(&mut self) -> Option<Box<Session<'static>>> {
        match std::mem::replace(&mut self.push_state, PushState::Idle) {
            PushState::Idle => None,
            // session is valid since it has not moved and the connection is pinned so has not moved either
            PushState::InProgress { session } => Some(unsafe { Box::from_raw(session.as_ptr()) }),
        }
    }

    /// Ends the capture and returns the inverted changeset.
    fn close_session(&mut self) -> Result<Vec<u8>> {
        let mut session = self
            .take_session()
            .ok_or_else(|| WasmError::Other(String::from("not in mutation")))?;
        let mut changeset = vec![];
        session.changeset_strm(&mut changeset)?;
        drop(session);

        let mut inverted_changeset = Vec::with_capacity(changeset.len());
        let mut input = changeset.as_slice();
        invert_strm(&mut input, &mut inverted_changeset)?;
        Ok(inverted_changeset)
    }

    /// Tables owned by a virtual table of the main schema (`docs_fts_data`, `geo_node`...).
    fn shadow_tables(&self) -> rusqlite::Result<std::collections::HashSet<String>> {
        let mut stmt = self.connection.prepare_cached(
            "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow'",
        )?;
        let tables = stmt
            .query_map((), |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(tables)
    }

    fn revert_changesets(&self, last_mutation_id: usize) -> rusqlite::Result<Vec<Mutation>> {
        let mut stmt = self.connection.prepare_cached(
            "SELECT id, name, json(args), changeset FROM pending_mutations ORDER by id DESC",
        )?;

        let mut changes: Vec<Mutation> = stmt
            .query_map((), |row| {
                let args = row.get_ref(2)?.as_str_or_null()?;
                let value = match args {
                    Some(args) => {
                        let value = serde_json::from_str(args).map_err(|e| {
                            rusqlite::Error::InvalidColumnType(
                                1,
                                e.to_string(),
                                rusqlite::types::Type::Text,
                            )
                        })?;
                        Some(value)
                    }
                    None => None,
                };

                Ok(Mutation {
                    id: row.get::<_, i64>(0)? as usize,
                    name: row.get(1)?,
                    args: value,
                    changeset: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        // changesets recorded before shadow tables were filtered out may still hold some
        let shadow_tables = std::sync::Arc::new(self.shadow_tables()?);
        for change in &changes {
            let mut slice: &[u8] = &change.changeset;
            let shadow_tables = shadow_tables.clone();
            self.connection.apply_strm(
                &mut slice,
                Some(move |table: &str| !shadow_tables.contains(table)),
                // https://sqlite.org/session.html#SQLITE_CHANGESET_ABORT
                |conflict_type, _| match conflict_type {
                    ConflictType::SQLITE_CHANGESET_DATA => ConflictAction::SQLITE_CHANGESET_REPLACE,
                    ConflictType::SQLITE_CHANGESET_NOTFOUND => {
                        ConflictAction::SQLITE_CHANGESET_OMIT
                    }
                    ConflictType::SQLITE_CHANGESET_CONFLICT => {
                        ConflictAction::SQLITE_CHANGESET_REPLACE
                    }
                    _ => ConflictAction::SQLITE_CHANGESET_ABORT,
                },
            )?;
        }

        changes.retain(|mutation| mutation.id > last_mutation_id);
        changes.reverse();
        Ok(changes)
    }

    fn apply_server_state(
        &self,
        mutations: Vec<TableMutation>,
    ) -> std::result::Result<(), rusqlite::Error> {
        let mut sql_string = String::with_capacity(256);
        for mutation in mutations {
            match mutation.op {
                MutationOp::Upsert => {
                    for record in mutation.records {
                        sql_string.clear();
                        Self::write_upsert(
                            &mut sql_string,
                            &mutation.table,
                            &record,
                            &mutation.pks,
                        );

                        let mut stmt = self.connection.prepare_cached(&sql_string)?;
                        stmt.execute(rusqlite::params_from_iter(
                            record.into_values().map(Self::to_rusqlite),
                        ))?;
                    }
                }
                MutationOp::Delete => {
                    let mut pks = mutation.pks;
                    for record in mutation.records {
                        sql_string.clear();
                        Self::write_delete(&mut sql_string, &mutation.table, &mut pks);

                        let mut stmt = self.connection.prepare_cached(&sql_string)?;
                        stmt.execute(rusqlite::params_from_iter(
                            record
                                .into_iter()
                                .filter(|(k, _)| pks.contains(k))
                                .map(|(_, v)| Self::to_rusqlite(v)),
                        ))?;
                    }
                }
            }
        }

        Ok(())
    }

    fn push_ident(out: &mut String, ident: &str) {
        out.push('"');
        for c in ident.chars() {
            if c == '"' {
                out.push('"');
            }
            out.push(c);
        }
        out.push('"');
    }

    fn write_upsert(
        sql: &mut String,
        table: &str,
        record: &BTreeMap<String, serde_json::Value>,
        pks: &[String],
    ) {
        sql.push_str("INSERT INTO ");
        Self::push_ident(sql, table);

        sql.push_str(" (");
        for (i, col) in record.keys().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            Self::push_ident(sql, col);
        }

        sql.push_str(") VALUES (");
        for i in 0..record.len() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push('?');
        }
        sql.push_str(") ON CONFLICT (");

        for (i, pk) in pks.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            Self::push_ident(sql, pk);
        }
        sql.push(')');

        let mut first = true;
        for col in record.keys().filter(|c| !pks.contains(c)) {
            sql.push_str(if first { " DO UPDATE SET " } else { ", " });
            first = false;
            Self::push_ident(sql, col);
            sql.push_str(" = EXCLUDED.");
            Self::push_ident(sql, col);
        }
        if first {
            sql.push_str(" DO NOTHING");
        }
    }

    fn write_delete(sql: &mut String, table: &str, pks: &mut [String]) {
        sql.push_str("DELETE FROM ");
        Self::push_ident(sql, table);
        pks.sort();
        sql.push_str(" WHERE ");
        if pks.len() == 1 {
            Self::push_ident(sql, &pks[0]);
        } else {
            sql.push('(');
            pks.iter().enumerate().for_each(|(i, key)| {
                Self::push_ident(sql, key);
                if i != pks.len() - 1 {
                    sql.push_str(", ");
                }
            });
            sql.push(')');
        }

        sql.push_str(" = ");
        if pks.len() == 1 {
            sql.push('?');
        } else {
            sql.push('(');
            pks.iter().enumerate().for_each(|(i, _)| {
                sql.push('?');
                if i != pks.len() - 1 {
                    sql.push_str(", ");
                }
            });
            sql.push(')');
        }
    }
}
