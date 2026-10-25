use std::{collections::BTreeMap, pin::Pin, ptr::NonNull};

use rusqlite::{
    params,
    session::{invert_strm, Session},
    types::ValueRef,
};
use serde::{Deserialize, Serialize};
use sqlite_wasm_rs::WasmOsCallback;
use sqlite_wasm_vfs::sahpool::OpfsSAHPoolCfg;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::WasmError::Sql;

pub enum WasmError {
    Sql(String),
    Serde(String),
    Other(String),
}

impl From<WasmError> for wasm_bindgen::JsValue {
    fn from(value: WasmError) -> Self {
        match value {
            WasmError::Sql(r) => wasm_bindgen::JsValue::from_str(&r),
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

    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[allow(unused_macros)]
macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

#[derive(Deserialize)]
pub struct SqlQuery {
    pub sql: String,
    pub params: Vec<serde_json::Value>,
    pub is_readonly: bool,
}

#[wasm_bindgen]
pub struct SqliteEngine {
    client_id: String,
    connection: Pin<Box<rusqlite::Connection>>,
    server_version: usize,
    pull_state: PullState,
    push_state: PushState,
}

#[derive(Serialize)]
pub struct SqlOutput {
    rows: Vec<serde_json::Value>,
    is_readonly: bool,
}

#[derive(Serialize)]
pub struct PullRequest {
    client_id: String,
    server_version: usize,
}

#[derive(Deserialize)]
pub struct PullResponse {
    server_version: usize,
    last_mutation_id: usize,
    mutations: Vec<TableMutation>,
}

#[derive(Serialize)]
pub struct LocalMutation {
    name: String,
    args: Option<serde_json::Value>,
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

#[derive(Clone)]
pub struct Mutation {
    id: usize,
    name: String,
    args: Option<serde_json::Value>,
    changeset: Vec<u8>,
}

#[derive(Debug)]
enum PullState {
    Idle,
    Awaiting,
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
    pub async fn create(db_path: &str) -> Result<Self> {
        if !db_path.contains(":memory:") {
            sqlite_wasm_vfs::sahpool::install::<WasmOsCallback>(&OpfsSAHPoolCfg::default(), true)
                .await?;
        }

        let conn = rusqlite::Connection::open(db_path)?;

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

        let id: i64 = match conn.query_row_and_then(
            "SELECT value FROM config WHERE key = 'server_version'",
            (),
            |row| row.get(0),
        ) {
            Ok(version) => version,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                conn.execute(
                    "INSERT INTO config (key, value) VALUES (?, ?)",
                    params!["server_version", 0],
                )?;
                0
            }
            err => err?,
        };

        Ok(SqliteEngine {
            client_id,
            connection: Box::pin(conn),
            server_version: id as usize,
            pull_state: PullState::Idle,
            push_state: PushState::Idle,
        })
    }

    #[wasm_bindgen]
    pub fn free(self) {
        drop(self);
    }

    #[wasm_bindgen(getter)]
    pub fn client_id(&self) -> String {
        self.client_id.clone()
    }

    #[wasm_bindgen]
    pub fn sql_exec(&self, query: JsSqlQuery) -> Result<JsSqlResult> {
        let query: SqlQuery = serde_wasm_bindgen::from_value(query.into())?;
        let mut stmt = self.connection.prepare_cached(&query.sql)?;
        let is_readonly = stmt.readonly();
        if query.is_readonly && !is_readonly {
            return Err(WasmError::Other(String::from("operation is not read only")));
        }

        let cols: Vec<_> = stmt.column_names().iter().map(|&c| c.to_string()).collect();

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
        if !matches!(self.pull_state, PullState::Idle) {
            return Err(WasmError::Other(String::from("pull state not idle")));
        }

        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        let request = PullRequest {
            server_version: self.server_version,
            client_id: self.client_id(),
        };

        let js_req = request.serialize(&serializer)?;
        self.pull_state = PullState::Awaiting;
        Ok(js_req.into())
    }

    #[wasm_bindgen]
    pub fn cancel_pull(&mut self) -> Result<()> {
        if !matches!(self.pull_state, PullState::Awaiting) {
            return Err(WasmError::Other(String::from("no pull in progress")));
        }
        self.pull_state = PullState::Idle;
        Ok(())
    }

    #[wasm_bindgen]
    pub fn start_rebasing(&mut self, response: JsPullResponse) -> Result<JsLocalMutations> {
        let response: PullResponse = serde_wasm_bindgen::from_value(response.into())?;
        self.pull_state = PullState::Idle;

        let mut stmt = self.connection.prepare_cached("BEGIN")?;
        stmt.execute(())?;

        let mut stmt = self
            .connection
            .prepare_cached("UPDATE config SET value = ? WHERE key = 'server_version'")?;
        stmt.execute((response.server_version as i64,))
            .map_err(|e| RollbackErr {
                reason: e.to_string(),
                conn: &self.connection,
            })?;

        let mutations = self
            .rever_changesets(response.last_mutation_id)
            .map_err(|e| RollbackErr {
                reason: e.to_string(),
                conn: &self.connection,
            })?;

        self.apply_server_state(response.mutations)
            .map_err(|e| RollbackErr {
                reason: e.to_string(),
                conn: &self.connection,
            })?;

        let response: Vec<_> = mutations
            .into_iter()
            .map(|m| LocalMutation {
                name: m.name,
                args: m.args,
            })
            .collect();
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        let response = response.serialize(&serializer).map_err(|e| RollbackErr {
            reason: e.to_string(),
            conn: &self.connection,
        })?;
        Ok(response.into())
    }

    #[wasm_bindgen]
    pub fn end_rebasing(&mut self, server_version: usize) -> Result<()> {
        self.pull_state = PullState::Idle;
        self.connection.execute("COMMIT", ())?;
        self.server_version = server_version;
        Ok(())
    }

    #[wasm_bindgen]
    pub fn start_mutate(&mut self) -> Result<()> {
        self.connection.execute("BEGIN", ())?;
        let mut session = Session::new(&self.connection).map_err(|e| RollbackErr {
            reason: e.to_string(),
            conn: &self.connection,
        })?;
        session.attach::<&str>(None).map_err(|e| RollbackErr {
            reason: e.to_string(),
            conn: &self.connection,
        })?;

        // we can assume static lifetime because connection is held by the struct and pin
        // clippy warn but we extend the lifetime so the as is necessary
        #[allow(clippy::unnecessary_cast)]
        let session = Box::into_raw(Box::new(session)) as *mut Session<'static>;

        let session = NonNull::new(session).unwrap();
        self.push_state = PushState::InProgress { session };
        Ok(())
    }

    #[wasm_bindgen]
    pub fn rollback(&self) -> Result<()> {
        self.connection.execute("ROLLBACK", ())?;
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
        match self.push_state {
            PushState::Idle => return Err(WasmError::Other(String::from("not in mutation"))),
            PushState::InProgress { session } => {
                {
                    // session is valid since it has not moved and the connection is pinned so has not moved either
                    let mut session = unsafe { Box::from_raw(session.as_ptr()) };
                    let mut changeset = vec![];

                    session.changeset_strm(&mut changeset)?;
                    let mut inverted_changeset = Vec::with_capacity(changeset.len());
                    let mut input = changeset.as_slice();
                    invert_strm(&mut input, &mut inverted_changeset)?;

                    let mut stmt = self.connection.prepare_cached(
                    "INSERT INTO pending_mutations (name, args, changeset) VALUES (?, jsonb(?), ?)",
                )?;

                    stmt.execute(params![name, args, inverted_changeset])?;
                }

                self.connection.execute("COMMIT", ())?;
                self.push_state = PushState::Idle;
            }
        };

        Ok(())
    }

    #[wasm_bindgen]
    pub fn export_db(&self) -> Result<Vec<u8>> {
        let data = self.connection.serialize("main")?;
        Ok(data.to_vec())
    }

    fn rever_changesets(&self, last_mutation_id: usize) -> rusqlite::Result<Vec<Mutation>> {
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

        for change in &changes {
            let mut slice: &[u8] = &change.changeset;
            self.connection
                .apply_strm(&mut slice, Option::<fn(&str) -> bool>::None, |_, _| {
                    rusqlite::session::ConflictAction::SQLITE_CHANGESET_ABORT
                })?;
        }
        changes.retain(|mutation| mutation.id > last_mutation_id);
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
