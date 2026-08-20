use local_ip_address::local_ip;
use once_cell::sync::Lazy;
use poem::{
    error::InternalServerError,
    get, handler,
    listener::TcpListener,
    post,
    web::{Json, Path},
    IntoResponse, Result, Route, Server,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{collections::HashMap, net::IpAddr};

#[path = "util/db.rs"]
mod db;

mod cloud_sync;
pub mod crypto;
pub(crate) mod event_problems;
mod migrations;
pub(crate) mod problems;
mod rpc;
pub(crate) mod sync_utils;

#[cfg(test)]
mod test_utils;

// Global encryption key holder for use by HTTP handlers
// The key is set when database is unlocked and cleared when locked
static GLOBAL_ENCRYPTION_KEY: Lazy<parking_lot::RwLock<Option<Vec<u8>>>> =
    Lazy::new(|| parking_lot::RwLock::new(None));

// Global pairing/RPC state for HTTP handlers (set when server starts)
static GLOBAL_SESSION_REGISTRY: Lazy<rpc::SessionRegistry> = Lazy::new(rpc::SessionRegistry::new);
static GLOBAL_HUB_PRIVATE_KEY: Lazy<parking_lot::RwLock<Option<[u8; 32]>>> =
    Lazy::new(|| parking_lot::RwLock::new(None));
static GLOBAL_HUB_PUBLIC_KEY: Lazy<parking_lot::RwLock<Option<crypto::pairing::PairingPublicKey>>> =
    Lazy::new(|| parking_lot::RwLock::new(None));
static GLOBAL_HUB_ID: Lazy<parking_lot::RwLock<Option<String>>> =
    Lazy::new(|| parking_lot::RwLock::new(None));
static GLOBAL_HUB_NAME: Lazy<parking_lot::RwLock<Option<String>>> =
    Lazy::new(|| parking_lot::RwLock::new(None));
static GLOBAL_JWT_SIGNING_KEY: Lazy<parking_lot::RwLock<Option<Vec<u8>>>> =
    Lazy::new(|| parking_lot::RwLock::new(None));

/// Simple error type for database operations in HTTP handlers
#[derive(Debug)]
struct DbError(String);

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for DbError {}

/// Opens an encrypted database connection using the global key
fn open_encrypted_connection() -> std::result::Result<Connection, DbError> {
    let key = GLOBAL_ENCRYPTION_KEY.read().clone().ok_or_else(|| {
        DbError("Database is locked. Please unlock with passphrase first.".to_string())
    })?;

    let db_path = db::get_database_path();
    db::open_encrypted(&db_path, &key).map_err(DbError)
}

/// Persists a peer to the `peers` table (upsert by client_id).
///
/// Called during handshake so the hub remembers every device that paired with it.
/// On re-pair the public key and timestamp are refreshed; creation time is preserved.
fn upsert_peer(client_id: &str, public_key: &str, device_name: Option<&str>) {
    let conn = match open_encrypted_connection() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("upsert_peer: failed to open DB — {}", e);
            return;
        }
    };

    let now = timestamp();
    let name = device_name.unwrap_or("Unknown device");

    let result = conn.execute(
        r#"
        INSERT INTO peers (id, peer_id, name, public_key, peer_type, status, protocol_version,
                           created_at, updated_at, local_server_created_at, local_server_last_modified_at)
        VALUES (?1, ?1, ?2, ?3, 'device', 'paired', '1',
                ?4, ?4, ?4, ?4)
        ON CONFLICT(id) DO UPDATE SET
            name       = CASE WHEN excluded.name != 'Unknown device' THEN excluded.name ELSE peers.name END,
            public_key = excluded.public_key,
            status     = 'paired',
            updated_at = excluded.updated_at,
            local_server_last_modified_at = excluded.local_server_last_modified_at
        "#,
        rusqlite::params![client_id, name, public_key, now],
    );

    match result {
        Ok(_) => println!("Peer '{}' upserted", client_id),
        Err(e) => eprintln!("upsert_peer: failed to upsert — {}", e),
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[handler]
fn hello(Path(name): Path<String>) -> String {
    println!("Hello: {name}");
    format!("Hello, {}!", name)
}

#[handler]
fn index_route() -> String {
    println!("Index route accessed");
    "Hello hikma health local server.".to_string()
}

/// Represents a single record in a table with its raw data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawRecord {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    // Other common fields could be added here - Should we??
    // Flatten the fields to support dynamic fields
    // TODO: Actually, does this do what I think it does. @ally review
    #[serde(flatten)]
    pub data: HashMap<String, serde_json::Value>,
}

/// Represents changes to a single table, categorized by operation type
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncTableChangeSet {
    pub created: Vec<RawRecord>,
    pub updated: Vec<RawRecord>,
    pub deleted: Vec<String>, // List of IDs to delete
}

/// Represents changes to the entire database, organized by table name
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncDatabaseChangeSet(HashMap<String, SyncTableChangeSet>);

impl SyncDatabaseChangeSet {
    /// Create a new empty change set
    pub fn new() -> Self {
        Self(HashMap::new())
    }

    /// Add a table's changes to the database change set
    pub fn add_table_changes(&mut self, table_name: &str, changes: SyncTableChangeSet) {
        if !changes.is_empty() {
            self.0.insert(table_name.to_string(), changes);
        }
    }

    /// Get changes for a specific table
    pub fn get_table_changes(&self, table_name: &str) -> Option<&SyncTableChangeSet> {
        self.0.get(table_name)
    }

    /// Get all table names that have changes
    pub fn table_names(&self) -> Vec<&String> {
        self.0.keys().collect()
    }

    /// Check if there are any changes in the database
    pub fn is_empty(&self) -> bool {
        self.0.is_empty() || self.0.values().all(|changes| changes.is_empty())
    }

    /// Iterate over (table_name, changeset) pairs.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &SyncTableChangeSet)> {
        self.0.iter()
    }
}

impl SyncTableChangeSet {
    /// Create a new empty table change set
    pub fn new() -> Self {
        Self {
            created: Vec::new(),
            updated: Vec::new(),
            deleted: Vec::new(),
        }
    }

    /// Check if there are any changes in this table
    pub fn is_empty(&self) -> bool {
        self.created.is_empty() && self.updated.is_empty() && self.deleted.is_empty()
    }

    /// Get the total number of changes in this table
    pub fn total_changes(&self) -> usize {
        self.created.len() + self.updated.len() + self.deleted.len()
    }

    /// Filter and repartition records by timestamp.
    ///
    /// All records (from both `created` and `updated`) are reclassified:
    /// - `created`: records with `created_at >= timestamp`
    /// - `updated`: records with `created_at < timestamp && updated_at >= timestamp`
    /// - Records not matching either window are excluded.
    /// - `deleted` IDs are always preserved.
    pub fn filter_by_timestamp(&self, timestamp: i64) -> Self {
        let all_records = self.created.iter().chain(self.updated.iter());

        let mut created = Vec::new();
        let mut updated = Vec::new();

        for record in all_records {
            if record.created_at >= timestamp {
                created.push(record.clone());
            } else if record.updated_at >= timestamp {
                updated.push(record.clone());
            }
        }

        Self {
            created,
            updated,
            deleted: self.deleted.clone(),
        }
    }
}

/// Upserts a record received from a client via REST sync.
///
/// Uses `now` for both `local_server_created_at` (on INSERT) and
/// `local_server_last_modified_at` (on INSERT and UPDATE), because these are
/// direct client writes that should appear in the cloud push set.
pub(crate) fn upsert_client_record(
    conn: &rusqlite::Connection,
    table: &str,
    record: &RawRecord,
    valid_columns: &std::collections::HashSet<String>,
    now: i64,
) -> std::result::Result<(), String> {
    let mut col_vals: Vec<(String, serde_json::Value)> = Vec::new();

    // Core fields
    col_vals.push((
        "id".to_string(),
        serde_json::Value::String(record.id.clone()),
    ));
    col_vals.push((
        "created_at".to_string(),
        serde_json::Value::Number(record.created_at.into()),
    ));
    col_vals.push((
        "updated_at".to_string(),
        serde_json::Value::Number(record.updated_at.into()),
    ));

    // All data fields (skip duplicates of core fields)
    for (key, val) in &record.data {
        if key == "id" || key == "created_at" || key == "updated_at" {
            continue;
        }
        col_vals.push((key.clone(), val.clone()));
    }

    // Filter to valid columns only
    let col_vals: Vec<(String, serde_json::Value)> = col_vals
        .into_iter()
        .filter(|(k, _)| valid_columns.contains(k))
        .collect();

    if col_vals.is_empty() {
        return Ok(());
    }

    // Build column + value lists
    let mut columns: Vec<String> = col_vals.iter().map(|(k, _)| k.clone()).collect();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = col_vals
        .iter()
        .map(|(_, v)| sync_utils::json_value_to_sql(v))
        .collect();

    // Server tracking: local_server_created_at = now (on INSERT)
    if valid_columns.contains("local_server_created_at")
        && !columns.contains(&"local_server_created_at".to_string())
    {
        columns.push("local_server_created_at".to_string());
        values.push(Box::new(now));
    }

    // Server tracking: local_server_last_modified_at = now (on INSERT and UPDATE)
    if valid_columns.contains("local_server_last_modified_at")
        && !columns.contains(&"local_server_last_modified_at".to_string())
    {
        columns.push("local_server_last_modified_at".to_string());
        values.push(Box::new(now));
    }

    // Placeholders
    let placeholders: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();

    // ON CONFLICT: update all data columns + local_server_last_modified_at,
    // but NOT id, local_server_created_at, or local_server_deleted_at
    let update_clauses: Vec<String> = columns
        .iter()
        .filter(|c| {
            c.as_str() != "id"
                && c.as_str() != "local_server_created_at"
                && c.as_str() != "local_server_deleted_at"
        })
        .map(|c| format!("\"{c}\" = excluded.\"{c}\""))
        .collect();

    let sql = if update_clauses.is_empty() {
        format!(
            "INSERT OR IGNORE INTO \"{}\" ({}) VALUES ({})",
            table,
            columns
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", "),
            placeholders.join(", "),
        )
    } else {
        format!(
            "INSERT INTO \"{}\" ({}) VALUES ({}) ON CONFLICT(id) DO UPDATE SET {}",
            table,
            columns
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", "),
            placeholders.join(", "),
            update_clauses.join(", "),
        )
    };

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|b| b.as_ref()).collect();

    conn.execute(&sql, rusqlite::params_from_iter(param_refs))
        .map_err(|e| format!("Upsert failed for {table} id={}: {e}", record.id))?;

    Ok(())
}

/// Soft-deletes a record received from a client via REST sync.
///
/// Bumps `local_server_last_modified_at` to `now` so the deletion propagates
/// to the cloud push set.
pub(crate) fn soft_delete_client_record(
    conn: &rusqlite::Connection,
    table: &str,
    id: &str,
    now: i64,
) -> std::result::Result<(), String> {
    let sql = format!(
        "UPDATE \"{}\" SET local_server_deleted_at = ?1, local_server_last_modified_at = ?1 \
         WHERE id = ?2 AND local_server_deleted_at IS NULL",
        table
    );
    conn.execute(&sql, rusqlite::params![now, id])
        .map_err(|e| format!("Soft-delete failed for {table} id={id}: {e}"))?;
    Ok(())
}

// Get current timestamp in milliseconds (Unix epoch)
pub(crate) fn timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

// ============================================================================
// RPC Handlers (Poem)
// ============================================================================

/// Unauthenticated liveness probe — returns 200 if the server is reachable.
#[handler]
fn rpc_heartbeat() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

#[handler]
fn rpc_handshake(Json(req): Json<rpc::HandshakeRequest>) -> Result<impl IntoResponse> {
    let hub_private = GLOBAL_HUB_PRIVATE_KEY
        .read()
        .ok_or_else(|| InternalServerError(DbError("Hub pairing keys not loaded".to_string())))?;
    let hub_pub = GLOBAL_HUB_PUBLIC_KEY
        .read()
        .ok_or_else(|| InternalServerError(DbError("Hub public key not loaded".to_string())))?;
    let hub_id = GLOBAL_HUB_ID
        .read()
        .clone()
        .ok_or_else(|| InternalServerError(DbError("Hub ID not loaded".to_string())))?;
    let hub_name = GLOBAL_HUB_NAME.read().clone().unwrap_or_default();

    let client_pub = crypto::pairing::decode_public_key(&req.client_public_key)
        .map_err(|e| InternalServerError(DbError(e)))?;

    let shared_key = crypto::pairing::derive_shared_key(&hub_private, &client_pub, &hub_pub)
        .map_err(|e| InternalServerError(DbError(e)))?;

    // Register client session (in-memory for this server lifetime)
    let client_id = rpc::ClientId(req.client_id);
    GLOBAL_SESSION_REGISTRY.register(rpc::ClientSession::new(
        client_id.clone(),
        client_pub,
        shared_key,
    ));

    // Persist the peer so the hub remembers it across restarts
    upsert_peer(
        &client_id.0,
        &req.client_public_key,
        req.device_name.as_deref(),
    );

    println!(
        "[rpc_handshake] session registered for client_id={}",
        client_id.0
    );

    Ok(Json(rpc::HandshakeResponse {
        hub_public_key: crypto::pairing::encode_public_key(&hub_pub),
        hub_id,
        hub_name,
        success: true,
    }))
}

/// Wire response for a dispatch-level error, preserving any `error_code` the
/// handler attached — without it the client can only string-match the message.
fn error_response(message: &str, result: &serde_json::Value) -> rpc::RpcResponse {
    match result.get("error_code").and_then(|v| v.as_str()) {
        Some(code) => rpc::RpcResponse::error_with_code(message, code),
        None => rpc::RpcResponse::error(message),
    }
}

#[handler]
fn rpc_command(Json(req): Json<rpc::RpcRequest>) -> Result<impl IntoResponse> {
    let client_id = rpc::ClientId(req.client_id);
    let shared_key = GLOBAL_SESSION_REGISTRY
        .get_shared_key(&client_id)
        .ok_or_else(|| {
            InternalServerError(DbError(format!(
                "Client '{}' not paired — handshake first",
                client_id.0
            )))
        })?;

    // Decrypt the command payload
    let plaintext = match crypto::pairing::decrypt(&shared_key, &req.payload, b"command") {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "[rpc_command] WARN: decryption failed for client_id={}",
                client_id.0
            );
            return Err(InternalServerError(DbError(format!(
                "Decryption failed: {}",
                e
            ))));
        }
    };

    let cmd: rpc::RpcCommandPayload = serde_json::from_slice(&plaintext)
        .map_err(|e| InternalServerError(DbError(format!("Invalid command JSON: {}", e))))?;

    println!(
        "[rpc_command] command={} client_id={}",
        cmd.command, client_id.0
    );

    // Dispatch command
    let result = handle_command(&cmd);

    // Check for dispatch-level errors before encrypting
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Ok(Json(error_response(err, &result)));
    }

    // Encrypt successful response
    let response_json = serde_json::to_vec(&result).map_err(|e| {
        InternalServerError(DbError(format!("Failed to serialize response: {}", e)))
    })?;

    let encrypted = crypto::pairing::encrypt(&shared_key, &response_json, b"command_response")
        .map_err(|e| InternalServerError(DbError(format!("Encryption failed: {}", e))))?;

    Ok(Json(rpc::RpcResponse::success(encrypted)))
}

#[handler]
fn rpc_query(Json(req): Json<rpc::RpcRequest>) -> Result<impl IntoResponse> {
    println!("[prc_query] Started: {}", req.client_id);
    let client_id = rpc::ClientId(req.client_id);
    let shared_key = GLOBAL_SESSION_REGISTRY
        .get_shared_key(&client_id)
        .ok_or_else(|| {
            println!("[prc_query] FAILED TO GET SHARED KEY: {}", &client_id.0);
            InternalServerError(DbError(format!(
                "Client '{}' not paired — handshake first",
                client_id.0
            )))
        })?;

    println!("[prc_query] shared_key: {:?}", &shared_key.0);

    // Decrypt the query payload
    let plaintext = match crypto::pairing::decrypt(&shared_key, &req.payload, b"query") {
        Ok(p) => p,
        Err(e) => {
            println!(
                "[rpc_query] WARN: decryption failed for client_id={}",
                client_id.0
            );
            return Err(InternalServerError(DbError(format!(
                "Decryption failed: {}",
                e
            ))));
        }
    };

    let qry: rpc::RpcQueryPayload = serde_json::from_slice(&plaintext)
        .map_err(|e| InternalServerError(DbError(format!("Invalid query JSON: {}", e))))?;

    println!("[rpc_query] query={} client_id={}", qry.query, client_id.0);

    // Dispatch query
    let result = handle_query(&qry);

    // Check for dispatch-level errors before encrypting
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Ok(Json(error_response(err, &result)));
    }

    // Encrypt successful response
    let response_json = serde_json::to_vec(&result).map_err(|e| {
        InternalServerError(DbError(format!("Failed to serialize response: {}", e)))
    })?;

    let encrypted = crypto::pairing::encrypt(&shared_key, &response_json, b"query_response")
        .map_err(|e| InternalServerError(DbError(format!("Encryption failed: {}", e))))?;

    Ok(Json(rpc::RpcResponse::success(encrypted)))
}

/// Dispatches an RPC command, opening an encrypted DB connection for write operations.
fn handle_command(cmd: &rpc::RpcCommandPayload) -> serde_json::Value {
    let jwt_key_guard = GLOBAL_JWT_SIGNING_KEY.read();
    let jwt_key = jwt_key_guard.as_deref();

    match open_encrypted_connection() {
        Ok(conn) => rpc::handlers::dispatch_command(cmd, &conn, jwt_key),
        // ping doesn't need the DB
        Err(_) if cmd.command == "ping" => serde_json::json!({ "pong": true }),
        Err(e) => {
            eprintln!(
                "[handle_command] ERROR: DB open failed for command={}: {e}",
                cmd.command
            );
            serde_json::json!({ "error": e.to_string() })
        }
    }
}

/// Dispatches an RPC query, opening an encrypted DB connection for read operations.
fn handle_query(qry: &rpc::RpcQueryPayload) -> serde_json::Value {
    let jwt_key_guard = GLOBAL_JWT_SIGNING_KEY.read();
    let jwt_key = jwt_key_guard.as_deref();

    match open_encrypted_connection() {
        Ok(conn) => rpc::handlers::dispatch_query(qry, &conn, jwt_key),
        // heartbeat and ping don't need the DB
        Err(_) if qry.query == "ping" => serde_json::json!({ "pong": true }),
        Err(_) if qry.query == "heartbeat" => serde_json::json!({ "status": "ok" }),
        Err(e) => {
            eprintln!(
                "[handle_query] ERROR: DB open failed for query={}: {e}",
                qry.query
            );
            serde_json::json!({ "error": e.to_string() })
        }
    }
}

/// Port the local hub binds for mobile-app-facing RPC + sync traffic.
const HUB_BIND_ADDRESS: &str = "0.0.0.0:4001";

/// Plain HTTP on a trusted LAN — **deliberately no transport-layer TLS**. The hub has no
/// CA-issued cert, and self-signed certs are rejected by iOS App Transport Security and the
/// Android system trust store, which breaks the mobile clients. PHI in transit is instead
/// protected at the application layer: every data endpoint is `/rpc/command` / `/rpc/query`
/// with an ECDH + AES-256-GCM encrypted payload (there is no plaintext data endpoint).
/// Full rationale + HIPAA framing: `README.md` and `src/rpc/procedures-readme.md` — keep in sync.
async fn start_server(
    ip_address: IpAddr,
    shutdown_token: Arc<tokio::sync::Notify>,
) -> Result<(), String> {
    let app = Route::new()
        .at("/", get(index_route))
        .at("/hello/:name", get(hello))
        .at("/rpc/heartbeat", get(rpc_heartbeat))
        .at("/rpc/handshake", post(rpc_handshake))
        .at("/rpc/command", post(rpc_command))
        .at("/rpc/query", post(rpc_query));

    println!("Starting HTTP server at http://{ip_address}:4001");

    let server = Server::new(TcpListener::bind(HUB_BIND_ADDRESS)).run(app);
    let shutdown = shutdown_token.notified();

    match tokio::select! {
        result = server => result.map_err(|e| e.to_string()),
        _ = shutdown => {
            println!("Server shutdown requested");
            Ok(())
        }
    } {
        Ok(()) => Ok(()),
        Err(e) => {
            eprintln!("Server error: {e}");
            Err(e)
        }
    }
}

fn init_db() {
    let db_path = db::get_database_path();
    db::create(&db_path);
    println!("Database initialized at: {:?}", db_path);
}

/// Path to the Stronghold file for secure key storage
fn get_stronghold_path() -> std::path::PathBuf {
    let mut exe = std::env::current_exe().expect("Failed to get current exe path");
    exe.set_file_name("hikma-health.stronghold");
    exe
}

/// Derives a 32-byte key for Stronghold using argon2
fn derive_stronghold_key(password: &str) -> Vec<u8> {
    use argon2::Argon2;

    // Fixed salt for Stronghold (the user passphrase + random salt protects the DB key)
    let argon_salt = b"hikma-health-stronghold-v1______"; // 32 bytes for argon2
    let mut key = [0u8; 32];

    Argon2::default()
        .hash_password_into(password.as_bytes(), argon_salt, &mut key)
        .expect("Failed to derive Stronghold key");

    key.to_vec()
}

/// Returns the "hikma-health" Stronghold client, handling three cases:
/// 1. Client on disk but not in memory → `load_client`
/// 2. Client already loaded this session → `get_client`
/// 3. Brand-new Stronghold, no client yet → `create_client`
macro_rules! get_or_create_stronghold_client {
    ($stronghold:expr) => {
        $stronghold
            .load_client("hikma-health")
            .or_else(|_| $stronghold.get_client("hikma-health"))
            .or_else(|_| $stronghold.create_client("hikma-health"))
            .map_err(|e| format!("Failed to get or create Stronghold client: {}", e))
    };
}

/// Registers the cloud server as a peer in the `peers` table (idempotent upsert).
///
/// Reads `cloud_server_url` and `hub_id` from Stronghold and inserts/updates the
/// cloud peer. Safe to call multiple times — ON CONFLICT updates the URL and timestamp.
/// Fails silently if DB is locked or Stronghold data is missing (best-effort).
fn upsert_cloud_peer(stronghold: &tauri_plugin_stronghold::stronghold::Stronghold) {
    let client = match get_or_create_stronghold_client!(stronghold) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("upsert_cloud_peer: failed to get Stronghold client — {}", e);
            return;
        }
    };

    let server_url = match client
        .store()
        .get(b"cloud_server_url")
        .ok()
        .flatten()
        .and_then(|b| String::from_utf8(b).ok())
    {
        Some(url) => url,
        None => return, // not registered yet — nothing to do
    };

    let hub_id = client
        .store()
        .get(b"hub_id")
        .ok()
        .flatten()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default();

    let peer_id = &server_url;

    let conn = match open_encrypted_connection() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("upsert_cloud_peer: DB not available — {}", e);
            return;
        }
    };

    let now = timestamp();

    let result = conn.execute(
        r#"
        INSERT INTO peers (id, peer_id, name, public_key, peer_type, status, protocol_version,
                           metadata, created_at, updated_at,
                           local_server_created_at, local_server_last_modified_at)
        VALUES (?1, ?1, ?2, '', 'cloud_server', 'registered', '1',
                ?3, ?4, ?4, ?4, ?4)
        ON CONFLICT(id) DO UPDATE SET
            name       = excluded.name,
            metadata   = excluded.metadata,
            status     = 'registered',
            updated_at = excluded.updated_at,
            local_server_last_modified_at = excluded.local_server_last_modified_at
        "#,
        rusqlite::params![
            peer_id,
            server_url,
            serde_json::json!({ "hub_id": hub_id }).to_string(),
            now,
        ],
    );

    match result {
        Ok(_) => println!("Cloud peer '{}' upserted", peer_id),
        Err(e) => eprintln!("upsert_cloud_peer: failed to upsert — {}", e),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    // Initialize Stronghold for secure salt storage
    // Using a fixed app password since user passphrase protects the DB key, not Stronghold
    let stronghold_path = get_stronghold_path();
    let stronghold_password = derive_stronghold_key("hikma-health-local-hub-v1");

    let stronghold =
        tauri_plugin_stronghold::stronghold::Stronghold::new(&stronghold_path, stronghold_password)
            .expect("Failed to initialize Stronghold");

    let stronghold_state = StrongholdState {
        stronghold: std::sync::Mutex::new(Some(stronghold)),
    };

    // Initialize with server state
    // Note: Migrations run after database unlock via initialize_encryption or unlock_database
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ServerState::default())
        .manage(EncryptionState::default())
        .manage(stronghold_state)
        .invoke_handler(tauri::generate_handler![
            greet,
            start_server_command,
            stop_server_command,
            get_server_status,
            check_device_registration,
            register_device,
            get_encryption_status,
            initialize_encryption,
            unlock_database,
            lock_database,
            rotate_encryption_key,
            get_pairing_info,
            sync_with_cloud_command,
            get_database_stats,
            get_authorized_clinics,
            clear_all_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Application state managing server and encryption
struct ServerState {
    is_running: Arc<std::sync::atomic::AtomicBool>,
    address: Arc<parking_lot::RwLock<Option<String>>>,
    shutdown_token: Arc<tokio::sync::Notify>,
    /// Signalled by the server task after it has fully stopped
    stopped_signal: Arc<tokio::sync::Notify>,
}

impl Default for ServerState {
    fn default() -> Self {
        Self {
            is_running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            address: Arc::new(parking_lot::RwLock::new(None)),
            shutdown_token: Arc::new(tokio::sync::Notify::new()),
            stopped_signal: Arc::new(tokio::sync::Notify::new()),
        }
    }
}

// Encryption state for managing database encryption key
struct EncryptionState {
    // Derived encryption key stored in memory after unlock
    encryption_key: Arc<parking_lot::RwLock<Option<Vec<u8>>>>,
    // Salt stored in Stronghold, cached here after first load
    salt: Arc<parking_lot::RwLock<Option<Vec<u8>>>>,
    // Whether the database has been unlocked this session
    is_unlocked: Arc<std::sync::atomic::AtomicBool>,
}

impl Default for EncryptionState {
    fn default() -> Self {
        Self {
            encryption_key: Arc::new(parking_lot::RwLock::new(None)),
            salt: Arc::new(parking_lot::RwLock::new(None)),
            is_unlocked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

// Stronghold state for secure storage of encryption salt
struct StrongholdState {
    stronghold: std::sync::Mutex<Option<tauri_plugin_stronghold::stronghold::Stronghold>>,
}

// Pure function to get server status
#[tauri::command]
fn get_server_status(state: tauri::State<ServerState>) -> Result<(bool, Option<String>), String> {
    let is_running = state.is_running.load(std::sync::atomic::Ordering::Acquire);
    let address = state.address.read().clone();
    Ok((is_running, address))
}

/// Returns quick counts of patients, visits, and events in the local database.
#[tauri::command]
fn get_database_stats() -> Result<(u64, u64, u64), String> {
    let conn = open_encrypted_connection().map_err(|e| e.0)?;

    let count = |table: &str| -> Result<u64, String> {
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM {} WHERE local_server_deleted_at IS NULL",
                table
            ),
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count {}: {}", table, e))
    };

    Ok((count("patients")?, count("visits")?, count("events")?))
}

/// One clinic this hub is authorized to sync.
/// `name` is `None` when the clinics table doesn't yet hold a row for the id
/// (e.g. before the first cloud pull has populated the local clinics table).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuthorizedClinic {
    id: String,
    name: Option<String>,
}

/// Returns the clinics this hub is authorized to sync, as configured on the
/// cloud server's `devices.clinic_ids`. Refreshes the cached device info from
/// `/api/hub/verify-key` so admin changes (clinic assignments) appear without
/// re-registration. Falls back to the cached info when the cloud is
/// unreachable. Resolves names from the local `clinics` table when available;
/// missing names are returned as `None` so the UI can show the id instead.
#[tauri::command]
async fn get_authorized_clinics(
    stronghold_state: tauri::State<'_, StrongholdState>,
) -> Result<Vec<AuthorizedClinic>, String> {
    // Read api_key + server_url so we can refresh from the cloud.
    let (api_key, server_url) = {
        let guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
        let stronghold = guard.as_ref().ok_or("Stronghold not initialized")?;
        let client = get_or_create_stronghold_client!(stronghold)?;
        let key = client
            .store()
            .get(b"cloud_api_key")
            .ok()
            .flatten()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or("Hub not registered — no API key stored")?;
        let url = client
            .store()
            .get(b"cloud_server_url")
            .ok()
            .flatten()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or("Hub not registered — no server URL stored")?;
        (key, url)
    };

    // Try a fresh verify-key call. On any failure, fall back to the cached
    // device info so the UI still works offline.
    let fresh_device_info = fetch_cloud_device_info(&server_url, &api_key).await;

    let device_info: CloudDeviceInfo = match fresh_device_info {
        Ok(info) => {
            // Persist the fresh copy so future calls (and other commands that
            // read cloud_device_info) see the latest clinic assignments.
            if let Err(e) = persist_cloud_device_info(&stronghold_state, &info) {
                eprintln!("[get_authorized_clinics] failed to update cache: {e}");
            }
            info
        }
        Err(e) => {
            eprintln!("[get_authorized_clinics] verify-key refresh failed, using cache: {e}");
            let bytes = {
                let guard = stronghold_state
                    .stronghold
                    .lock()
                    .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
                let stronghold = guard.as_ref().ok_or("Stronghold not initialized")?;
                let client = get_or_create_stronghold_client!(stronghold)?;
                client
                    .store()
                    .get(b"cloud_device_info")
                    .ok()
                    .flatten()
                    .ok_or("Hub not registered — no device info stored")?
            };
            serde_json::from_slice(&bytes)
                .map_err(|e| format!("Failed to parse stored device info: {}", e))?
        }
    };

    let ids: Vec<String> = match device_info.extra.get("clinic_ids") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    };

    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let conn = open_encrypted_connection().map_err(|e| e.0)?;
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, name FROM clinics WHERE id IN ({}) AND (is_deleted IS NULL OR is_deleted = 0)",
        placeholders
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare clinic query: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("Failed to query clinics: {}", e))?;

    let mut name_by_id: HashMap<String, Option<String>> = HashMap::new();
    for r in rows.flatten() {
        name_by_id.insert(r.0, r.1);
    }

    Ok(ids
        .into_iter()
        .map(|id| {
            let name = name_by_id.remove(&id).unwrap_or(None);
            AuthorizedClinic { id, name }
        })
        .collect())
}

/// POSTs the api_key to `/api/hub/verify-key` and parses the device response.
async fn fetch_cloud_device_info(
    server_url: &str,
    api_key: &str,
) -> std::result::Result<CloudDeviceInfo, String> {
    let url = format!("{}/api/hub/verify-key", server_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "api_key": api_key }))
        .send()
        .await
        .map_err(|e| format!("Connection error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("verify-key HTTP {status}: {body}"));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read body: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("Bad verify-key response: {e}. Body: {body}"))
}

/// Updates the cached `cloud_device_info` blob in Stronghold.
fn persist_cloud_device_info(
    stronghold_state: &tauri::State<'_, StrongholdState>,
    info: &CloudDeviceInfo,
) -> std::result::Result<(), String> {
    let bytes =
        serde_json::to_vec(info).map_err(|e| format!("Failed to serialize device info: {e}"))?;
    let guard = stronghold_state
        .stronghold
        .lock()
        .map_err(|e| format!("Stronghold lock poisoned: {e}"))?;
    let stronghold = guard.as_ref().ok_or("Stronghold not initialized")?;
    let client = get_or_create_stronghold_client!(stronghold)?;
    let _ = client.store().delete(b"cloud_device_info");
    client
        .store()
        .insert(b"cloud_device_info".to_vec(), bytes, None)
        .map_err(|e| format!("Failed to store device info: {e}"))?;
    stronghold
        .save()
        .map_err(|e| format!("Failed to save Stronghold: {e}"))?;
    Ok(())
}

// Start server command - more functional with less mutable state
#[tauri::command]
async fn start_server_command<'a>(
    state: tauri::State<'a, ServerState>,
    stronghold_state: tauri::State<'a, StrongholdState>,
) -> Result<String, String> {
    init_db();

    // If our state thinks the server is running, gracefully stop the prior
    // task before binding again. This handles cases where the UI got out of
    // sync (page reload, restart click) without leaving an orphan task.
    if state.is_running.load(std::sync::atomic::Ordering::Acquire) {
        println!("[start_server] internal server still flagged as running — stopping first");
        let stopped = state.stopped_signal.notified();
        state.shutdown_token.notify_one();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), stopped).await;
        // Force-reset state so we definitely proceed past this point.
        *state.address.write() = None;
        state
            .is_running
            .store(false, std::sync::atomic::Ordering::Release);
    }

    // Probe the port synchronously so EADDRINUSE surfaces here, not as a
    // silent eprintln from the spawned task. Drop the probe immediately so
    // poem can rebind. There's a tiny TOCTOU window, but in practice the
    // OS releases the port the moment the probe is dropped.
    if let Err(e) = std::net::TcpListener::bind(HUB_BIND_ADDRESS) {
        return Err(format!(
            "Cannot bind {HUB_BIND_ADDRESS}: {e}. \
             Find the holding process with `lsof -nP -iTCP:4001 -sTCP:LISTEN` and stop it."
        ));
    }

    // Load pairing keys from Stronghold into globals (best-effort — hub may not be registered yet)
    {
        let stronghold_guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
        if let Some(stronghold) = stronghold_guard.as_ref() {
            if let Ok(client) = get_or_create_stronghold_client!(stronghold) {
                if let Some(hub_id_bytes) = client.store().get(b"hub_id").ok().flatten() {
                    if let Ok(hub_id) = String::from_utf8(hub_id_bytes) {
                        *GLOBAL_HUB_ID.write() = Some(hub_id);
                    }
                }
                if let Some(hub_name_bytes) = client.store().get(b"hub_name").ok().flatten() {
                    if let Ok(hub_name) = String::from_utf8(hub_name_bytes) {
                        *GLOBAL_HUB_NAME.write() = Some(hub_name);
                    }
                }
                if let Some(pk_bytes) = client.store().get(b"pairing_private_key").ok().flatten() {
                    if pk_bytes.len() == 32 {
                        let mut arr = [0u8; 32];
                        arr.copy_from_slice(&pk_bytes);
                        let pub_key = crypto::pairing::public_key_from_private(&arr);
                        *GLOBAL_HUB_PRIVATE_KEY.write() = Some(arr);
                        *GLOBAL_HUB_PUBLIC_KEY.write() = Some(pub_key);
                    }
                }

                // Load or generate JWT signing key
                match client.store().get(b"jwt_signing_key").ok().flatten() {
                    Some(key) if key.len() == 32 => {
                        *GLOBAL_JWT_SIGNING_KEY.write() = Some(key);
                    }
                    _ => {
                        use ring::rand::{SecureRandom, SystemRandom};
                        let rng = SystemRandom::new();
                        let mut key = vec![0u8; 32];
                        if rng.fill(&mut key).is_ok() {
                            if client
                                .store()
                                .insert(b"jwt_signing_key".to_vec(), key.clone(), None)
                                .is_ok()
                            {
                                let _ = stronghold.save();
                            }
                            *GLOBAL_JWT_SIGNING_KEY.write() = Some(key);
                        }
                    }
                }
            }
        }
    }

    // Get IP address
    local_ip()
        .map_err(|e| format!("Failed to get local IP: {}", e))
        .and_then(|ip_address| {
            // Start server in background
            let server_address = format!("http://{}:4001", ip_address);

            // Clone the state components for use in the async block
            let is_running = state.is_running.clone();
            let address = state.address.clone();
            let shutdown_token = state.shutdown_token.clone();
            let stopped_signal = state.stopped_signal.clone();

            // Spawn server and update state atomically
            tauri::async_runtime::spawn(async move {
                // Set running state before starting
                *address.write() = Some(server_address.clone());
                is_running.store(true, std::sync::atomic::Ordering::Release);

                // Run server (this will block until server exits or shutdown is requested)
                let server_result = start_server(ip_address, shutdown_token).await;

                // Reset state when server exits — clear address before flipping the flag
                *address.write() = None;
                is_running.store(false, std::sync::atomic::Ordering::Release);

                // Notify anyone waiting for the server to fully stop
                stopped_signal.notify_waiters();

                // Log any errors
                if let Err(e) = server_result {
                    eprintln!("Server error: {}", e);
                }
            });

            Ok(format!("Server started at http://{}:4001", ip_address))
        })
}

// Stop server command that waits for the server to fully stop
#[tauri::command]
async fn stop_server_command(state: tauri::State<'_, ServerState>) -> Result<String, String> {
    // Check if server is running
    if !state.is_running.load(std::sync::atomic::Ordering::Acquire) {
        return Err("No server is running".to_string());
    }

    // Register the waiter BEFORE sending the shutdown signal to avoid missed notifications
    let stopped = state.stopped_signal.notified();

    // Signal the server to shut down
    state.shutdown_token.notify_one();

    // Wait for the server task to confirm it has stopped (with timeout)
    match tokio::time::timeout(std::time::Duration::from_secs(5), stopped).await {
        Ok(()) => Ok("Server stopped".to_string()),
        Err(_) => {
            // Timeout — force-reset state so the UI isn't stuck
            *state.address.write() = None;
            state
                .is_running
                .store(false, std::sync::atomic::Ordering::Release);
            Err("Server stop timed out — state has been reset".to_string())
        }
    }
}

// ============================================================================
// Device Registration Commands
// ============================================================================

/// Check if the device has been registered with a cloud server (local-only, no network)
#[tauri::command]
fn check_device_registration(
    stronghold_state: tauri::State<StrongholdState>,
) -> Result<bool, String> {
    let stronghold_guard = stronghold_state
        .stronghold
        .lock()
        .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
    let stronghold = stronghold_guard
        .as_ref()
        .ok_or("Stronghold not initialized")?;

    let client = match get_or_create_stronghold_client!(stronghold) {
        Ok(c) => c,
        Err(_) => return Ok(false),
    };

    let has_key = client
        .store()
        .get(b"cloud_api_key")
        .ok()
        .flatten()
        .is_some();
    let has_url = client
        .store()
        .get(b"cloud_server_url")
        .ok()
        .flatten()
        .is_some();

    Ok(has_key && has_url)
}

/// Register device by verifying API key against the cloud server and persisting credentials
#[tauri::command]
async fn register_device(
    api_key: String,
    server_url: String,
    stronghold_state: tauri::State<'_, StrongholdState>,
) -> Result<String, String> {
    let api_key = api_key.trim().to_string();
    let server_url = server_url.trim().trim_end_matches('/').to_string();

    if api_key.is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    if server_url.is_empty() {
        return Err("Server URL cannot be empty".to_string());
    }

    // POST to cloud to verify the key
    let verify_url = format!("{}/api/hub/verify-key", server_url);
    println!("[register_device] POST {}", verify_url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .post(&verify_url)
        .json(&serde_json::json!({ "api_key": api_key }))
        .send()
        .await
        .map_err(|e| format!("Connection error: {}", e))?;

    println!("[register_device] Response status: {}", response.status());

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "No response body".to_string());
        return Err(format!("Verification failed (HTTP {}): {}", status, body));
    }

    // Read response body as text first, then parse — separates network issues
    // from deserialization issues when diagnosing hangs
    let body_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    println!(
        "[register_device] Response body received ({} bytes)",
        body_text.len()
    );

    let device_info: CloudDeviceInfo = serde_json::from_str(&body_text)
        .map_err(|e| format!("Failed to parse cloud response: {}. Body: {}", e, body_text))?;

    let hub_id = device_info.id.clone();
    println!("[register_device] Hub ID: {}", hub_id);

    let device_info_json = serde_json::to_vec(&device_info)
        .map_err(|e| format!("Failed to serialize device info: {}", e))?;

    // Generate X25519 keypair for device pairing
    let keypair = crypto::pairing::generate_keypair();
    println!("[register_device] Keypair generated");

    // Persist credentials + pairing keys in Stronghold
    {
        let stronghold_guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
        let stronghold = stronghold_guard
            .as_ref()
            .ok_or("Stronghold not initialized")?;

        let client = get_or_create_stronghold_client!(stronghold)?;

        client
            .store()
            .insert(b"cloud_api_key".to_vec(), api_key.into_bytes(), None)
            .map_err(|e| format!("Failed to store API key: {}", e))?;

        client
            .store()
            .insert(
                b"cloud_server_url".to_vec(),
                server_url.clone().into_bytes(),
                None,
            )
            .map_err(|e| format!("Failed to store server URL: {}", e))?;

        client
            .store()
            .insert(b"hub_id".to_vec(), hub_id.as_bytes().to_vec(), None)
            .map_err(|e| format!("Failed to store hub ID: {}", e))?;

        client
            .store()
            .insert(
                b"hub_name".to_vec(),
                device_info.name.as_bytes().to_vec(),
                None,
            )
            .map_err(|e| format!("Failed to store hub name: {}", e))?;

        client
            .store()
            .insert(b"cloud_device_info".to_vec(), device_info_json, None)
            .map_err(|e| format!("Failed to store device info: {}", e))?;

        client
            .store()
            .insert(
                b"pairing_private_key".to_vec(),
                keypair.private_key_bytes.to_vec(),
                None,
            )
            .map_err(|e| format!("Failed to store pairing private key: {}", e))?;

        client
            .store()
            .insert(
                b"pairing_public_key".to_vec(),
                keypair.public_key.0.to_vec(),
                None,
            )
            .map_err(|e| format!("Failed to store pairing public key: {}", e))?;

        println!("[register_device] Saving Stronghold...");
        stronghold
            .save()
            .map_err(|e| format!("Failed to save Stronghold: {}", e))?;

        // Best-effort: register cloud server as a peer if DB is already unlocked
        upsert_cloud_peer(stronghold);
    }

    println!("[register_device] Device registered successfully");
    Ok("Device registered successfully".to_string())
}

// ============================================================================
// Encryption Commands
// ============================================================================

/// Check if the database is encrypted and if a passphrase has been set
#[tauri::command]
fn get_encryption_status(
    enc_state: tauri::State<EncryptionState>,
) -> Result<EncryptionStatus, String> {
    let db_path = db::get_database_path();
    let db_exists = db_path.exists();
    let is_encrypted = db_exists && db::is_encrypted(&db_path);
    let is_unlocked = enc_state
        .is_unlocked
        .load(std::sync::atomic::Ordering::Relaxed);

    Ok(EncryptionStatus {
        database_exists: db_exists,
        is_encrypted,
        is_unlocked,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptionStatus {
    database_exists: bool,
    is_encrypted: bool,
    is_unlocked: bool,
}

/// Parsed cloud verify-key response
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CloudDeviceInfo {
    id: String,
    name: String,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

/// Pairing info returned to the frontend for QR code rendering
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PairingInfo {
    hub_id: String,
    hub_name: String,
    public_key: String, // base64url-encoded
    address: String,
}

/// Initialize encryption with a new passphrase (first-time setup)
/// Creates salt, derives key, and either creates new encrypted DB or encrypts existing
#[tauri::command]
async fn initialize_encryption(
    passphrase: String,
    enc_state: tauri::State<'_, EncryptionState>,
    stronghold_state: tauri::State<'_, StrongholdState>,
) -> Result<String, String> {
    println!("[initialize_encryption] Starting encryption initialization");

    // Generate a new salt for this installation
    let salt = crypto::generate_salt();
    println!(
        "[initialize_encryption] Salt generated ({} bytes)",
        salt.len()
    );

    // Derive the encryption key from the passphrase
    let key = crypto::derive_key_from_passphrase(&passphrase, &salt);
    println!(
        "[initialize_encryption] Encryption key derived ({} bytes)",
        key.len()
    );

    let db_path = db::get_database_path();
    println!("[initialize_encryption] Database path: {:?}", db_path);

    // Store salt in Stronghold using the store (key-value storage)
    {
        println!("[initialize_encryption] Acquiring Stronghold lock...");
        let stronghold_guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
        let stronghold = stronghold_guard
            .as_ref()
            .ok_or("Stronghold not initialized")?;
        println!("[initialize_encryption] Stronghold lock acquired");

        // Get or create client (may already exist from device registration)
        let client = get_or_create_stronghold_client!(stronghold)?;
        println!("[initialize_encryption] Stronghold client obtained");

        // Store salt in the client's store
        client
            .store()
            .insert(b"encryption_salt".to_vec(), salt.clone(), None)
            .map_err(|e| format!("Failed to store salt: {}", e))?;
        println!("[initialize_encryption] Salt stored in Stronghold");

        // Save Stronghold to persist the data
        stronghold
            .save()
            .map_err(|e| format!("Failed to save Stronghold: {}", e))?;
        println!("[initialize_encryption] Stronghold saved to disk");
    }

    // Handle database encryption based on current state
    if db_path.exists() {
        println!("[initialize_encryption] Database file exists, checking encryption status...");
        if !db::is_encrypted(&db_path) {
            // Encrypt existing unencrypted database
            println!("[initialize_encryption] Database is not encrypted, encrypting existing database...");
            db::encrypt_existing(&db_path, &key)?;
            println!("[initialize_encryption] Encrypted existing database successfully");
        } else {
            println!("[initialize_encryption] Database is already encrypted, returning error");
            return Err("Database is already encrypted. Use unlock instead.".to_string());
        }
    } else {
        // Create new encrypted database
        println!("[initialize_encryption] No existing database found, creating new encrypted database...");
        db::create_encrypted(&db_path, &key)?;
        println!("[initialize_encryption] Created new encrypted database successfully");
    }

    // Store key in memory for this session
    *enc_state.encryption_key.write() = Some(key.clone());
    *enc_state.salt.write() = Some(salt);
    enc_state
        .is_unlocked
        .store(true, std::sync::atomic::Ordering::Relaxed);
    println!("[initialize_encryption] Encryption state updated in memory");

    // Update global key for HTTP handlers
    *GLOBAL_ENCRYPTION_KEY.write() = Some(key.clone());
    println!("[initialize_encryption] Global encryption key updated for HTTP handlers");

    // Run migrations on the newly created/encrypted database
    println!("[initialize_encryption] Opening encrypted database for migrations...");
    let mut conn = db::open_encrypted(&db_path, &key)?;
    println!("[initialize_encryption] Running migrations...");
    migrations::run_migrations(&mut conn)?;
    println!("[initialize_encryption] Migrations completed successfully");
    drop(conn);

    // Register cloud server as peer now that DB is available
    {
        let stronghold_guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
        if let Some(stronghold) = stronghold_guard.as_ref() {
            upsert_cloud_peer(stronghold);
        }
    }

    println!("[initialize_encryption] Encryption initialized successfully");
    Ok("Encryption initialized successfully".to_string())
}

/// Unlock the database with the user's passphrase
#[tauri::command]
async fn unlock_database(
    passphrase: String,
    enc_state: tauri::State<'_, EncryptionState>,
    stronghold_state: tauri::State<'_, StrongholdState>,
) -> Result<String, String> {
    println!("[unlock_database] Starting database unlock");

    // Load salt from Stronghold
    let salt = {
        println!("[unlock_database] Acquiring Stronghold lock...");
        let stronghold_guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
        let stronghold = stronghold_guard
            .as_ref()
            .ok_or("Stronghold not initialized")?;
        println!("[unlock_database] Stronghold lock acquired");

        // Load the client
        let client = get_or_create_stronghold_client!(stronghold)?;
        println!("[unlock_database] Stronghold client obtained");

        // Get salt from the store
        let salt = client
            .store()
            .get(b"encryption_salt")
            .map_err(|e| format!("Failed to retrieve salt: {}", e))?
            .ok_or("No salt found. Has encryption been initialized?")?;
        println!("[unlock_database] Salt retrieved ({} bytes)", salt.len());
        salt
    };

    // Derive key from passphrase and salt
    let key = crypto::derive_key_from_passphrase(&passphrase, &salt);
    println!(
        "[unlock_database] Encryption key derived ({} bytes)",
        key.len()
    );

    // Verify key by attempting to open the database and run any pending migrations
    let db_path = db::get_database_path();
    println!("[unlock_database] Database path: {:?}", db_path);
    println!("[unlock_database] Opening encrypted database...");
    let mut conn = db::open_encrypted(&db_path, &key)?;
    println!("[unlock_database] Database opened successfully");

    // Run any pending migrations
    println!("[unlock_database] Running migrations...");
    migrations::run_migrations(&mut conn)?;
    println!("[unlock_database] Migrations completed successfully");
    drop(conn);

    // Store key in memory for this session
    *enc_state.encryption_key.write() = Some(key.clone());
    *enc_state.salt.write() = Some(salt);
    enc_state
        .is_unlocked
        .store(true, std::sync::atomic::Ordering::Relaxed);
    println!("[unlock_database] Encryption state updated in memory");

    // Update global key for HTTP handlers
    *GLOBAL_ENCRYPTION_KEY.write() = Some(key);
    println!("[unlock_database] Global encryption key updated for HTTP handlers");

    // Register cloud server as peer now that DB is available
    {
        let stronghold_guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
        if let Some(stronghold) = stronghold_guard.as_ref() {
            upsert_cloud_peer(stronghold);
        }
    }

    println!("[unlock_database] Database unlocked successfully");
    Ok("Database unlocked successfully".to_string())
}

/// Lock the database (clear encryption key from memory)
#[tauri::command]
fn lock_database(enc_state: tauri::State<EncryptionState>) -> Result<String, String> {
    *enc_state.encryption_key.write() = None;
    enc_state
        .is_unlocked
        .store(false, std::sync::atomic::Ordering::Relaxed);

    // Clear global key
    *GLOBAL_ENCRYPTION_KEY.write() = None;

    Ok("Database locked".to_string())
}

/// Rotate the encryption key with a new passphrase
#[tauri::command]
async fn rotate_encryption_key(
    current_passphrase: String,
    new_passphrase: String,
    enc_state: tauri::State<'_, EncryptionState>,
    stronghold_state: tauri::State<'_, StrongholdState>,
) -> Result<String, String> {
    // First verify the current passphrase and get old salt
    let old_salt = {
        let stronghold_guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
        let stronghold = stronghold_guard
            .as_ref()
            .ok_or("Stronghold not initialized")?;

        let client = get_or_create_stronghold_client!(stronghold)?;

        client
            .store()
            .get(b"encryption_salt")
            .map_err(|e| format!("Failed to retrieve salt: {}", e))?
            .ok_or("No salt found")?
    };

    let old_key = crypto::derive_key_from_passphrase(&current_passphrase, &old_salt);

    // Open database with current key to verify it's correct
    let db_path = db::get_database_path();
    let conn = db::open_encrypted(&db_path, &old_key)?;

    // Generate new salt and derive new key
    let new_salt = crypto::generate_salt();
    let new_key = crypto::derive_key_from_passphrase(&new_passphrase, &new_salt);

    // Rotate the encryption key using PRAGMA rekey
    db::rotate_encryption_key(&conn, &new_key)?;
    drop(conn);

    // Update salt in Stronghold
    {
        let stronghold_guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
        let stronghold = stronghold_guard
            .as_ref()
            .ok_or("Stronghold not initialized")?;

        let client = get_or_create_stronghold_client!(stronghold)?;

        // Delete old salt and insert new one
        let _ = client.store().delete(b"encryption_salt");
        client
            .store()
            .insert(b"encryption_salt".to_vec(), new_salt.clone(), None)
            .map_err(|e| format!("Failed to store new salt: {}", e))?;

        stronghold
            .save()
            .map_err(|e| format!("Failed to save Stronghold: {}", e))?;
    }

    // Update in-memory state
    *enc_state.encryption_key.write() = Some(new_key.clone());
    *enc_state.salt.write() = Some(new_salt);

    // Update global key for HTTP handlers
    *GLOBAL_ENCRYPTION_KEY.write() = Some(new_key);

    Ok("Encryption key rotated successfully".to_string())
}

/// Clear all domain data from the local database.
///
/// Requires the user's passphrase for confirmation — derives the key and
/// compares it to the current encryption key before proceeding.
#[tauri::command]
async fn clear_all_data(
    passphrase: String,
    enc_state: tauri::State<'_, EncryptionState>,
    stronghold_state: tauri::State<'_, StrongholdState>,
) -> Result<serde_json::Value, String> {
    // Load salt from Stronghold
    let salt = {
        let stronghold_guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
        let stronghold = stronghold_guard
            .as_ref()
            .ok_or("Stronghold not initialized")?;
        let client = get_or_create_stronghold_client!(stronghold)?;
        client
            .store()
            .get(b"encryption_salt")
            .map_err(|e| format!("Failed to retrieve salt: {}", e))?
            .ok_or("No salt found. Has encryption been initialized?")?
    };

    // Derive key from passphrase and compare to the current encryption key
    let derived_key = crypto::derive_key_from_passphrase(&passphrase, &salt);
    let current_key = get_encryption_key(&enc_state)?;
    if derived_key != current_key {
        return Err("Invalid passphrase".to_string());
    }

    // Passphrase verified — clear all data
    let conn = open_encrypted_connection().map_err(|e| e.to_string())?;
    rpc::handlers::data::clear_all_tables(&conn).map_err(|e| e.to_string())
}

/// Returns pairing info for QR code rendering: hub_id, public key (base64), server address
#[tauri::command]
fn get_pairing_info(
    state: tauri::State<ServerState>,
    stronghold_state: tauri::State<StrongholdState>,
) -> Result<PairingInfo, String> {
    let stronghold_guard = stronghold_state
        .stronghold
        .lock()
        .map_err(|e| format!("Stronghold lock poisoned: {}", e))?;
    let stronghold = stronghold_guard
        .as_ref()
        .ok_or("Stronghold not initialized")?;

    let client = get_or_create_stronghold_client!(stronghold)?;

    let hub_id = client
        .store()
        .get(b"hub_id")
        .ok()
        .flatten()
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or("Hub not registered — no hub_id found")?;

    let hub_name = client
        .store()
        .get(b"hub_name")
        .ok()
        .flatten()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default();

    let pub_key_bytes = client
        .store()
        .get(b"pairing_public_key")
        .ok()
        .flatten()
        .ok_or("Hub not registered — no pairing key found")?;

    if pub_key_bytes.len() != 32 {
        return Err("Stored public key has invalid length".to_string());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&pub_key_bytes);
    let pk = crypto::pairing::PairingPublicKey(arr);
    let public_key_b64 = crypto::pairing::encode_public_key(&pk);

    let address = state
        .address
        .read()
        .clone()
        .unwrap_or_else(|| "unknown".to_string());

    Ok(PairingInfo {
        hub_id,
        hub_name,
        public_key: public_key_b64,
        address,
    })
}

// ============================================================================
// Cloud Sync Command
// ============================================================================

/// Triggers a full pull → merge → push cycle with the cloud server.
///
/// Reads credentials from Stronghold, opens the encrypted DB, and delegates
/// to `cloud_sync::sync_with_cloud`. Returns a summary for the frontend.
#[tauri::command]
async fn sync_with_cloud_command(
    stronghold_state: tauri::State<'_, StrongholdState>,
) -> Result<cloud_sync::CloudSyncSummary, String> {
    println!("[cloud_sync] starting");

    // Read cloud_url + api_key from Stronghold
    let (cloud_url, api_key) = {
        println!("[cloud_sync] acquiring Stronghold lock");
        let guard = stronghold_state
            .stronghold
            .lock()
            .map_err(|e| format!("Stronghold lock poisoned: {e}"))?;
        let stronghold = guard.as_ref().ok_or("Stronghold not initialized")?;
        let client = get_or_create_stronghold_client!(stronghold)?;
        println!("[cloud_sync] Stronghold client obtained");

        let url = client
            .store()
            .get(b"cloud_server_url")
            .ok()
            .flatten()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or("Device not registered — no cloud server URL")?;
        let key = client
            .store()
            .get(b"cloud_api_key")
            .ok()
            .flatten()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or("Device not registered — no API key")?;

        println!("[cloud_sync] cloud_url={url}");
        (url, key)
    };

    // Phase 1: read watermark and detect first-sync condition
    println!("[cloud_sync] phase 1/5 reading watermark");
    let (last_pulled_at, first_sync) = {
        let conn = open_encrypted_connection().map_err(|e| e.to_string())?;
        let wm = cloud_sync::phase_read_watermark(&conn).map_err(|e| e.to_string())?;
        let first = cloud_sync::is_first_sync(&conn, wm).map_err(|e| e.to_string())?;
        (wm, first)
    };
    println!("[cloud_sync] phase 1/5 complete, last_pulled_at={last_pulled_at}, first_sync={first_sync}");

    // Phase 2: pull from cloud (async HTTP, no DB connection held)
    println!("[cloud_sync] phase 2/5 pulling from cloud");
    let (cloud_changes, cloud_timestamp) =
        cloud_sync::phase_pull(&cloud_url, &api_key, last_pulled_at)
            .await
            .map_err(|e| e.to_string())?;
    println!(
        "[cloud_sync] phase 2/5 complete, cloud_timestamp={cloud_timestamp}, tables={}",
        cloud_changes.table_names().len()
    );

    if first_sync {
        // First sync: merge only, skip gather+push to avoid echoing
        // freshly-pulled cloud data back to the server.
        println!("[cloud_sync] phase 3/5 merging cloud changes (first sync, pull-only)");
        let (merged_c, merged_u, merged_d) = {
            let conn = open_encrypted_connection().map_err(|e| e.to_string())?;
            cloud_sync::phase_merge(&conn, &cloud_changes).map_err(|e| e.to_string())?
        };
        println!("[cloud_sync] phase 3/5 complete, merged (c={merged_c}, u={merged_u}, d={merged_d})");
        println!("[cloud_sync] phase 4/5 skipped (first sync)");

        println!("[cloud_sync] phase 5/5 updating watermark to {cloud_timestamp}");
        {
            let conn = open_encrypted_connection().map_err(|e| e.to_string())?;
            cloud_sync::phase_update_watermark(&conn, cloud_timestamp)
                .map_err(|e| e.to_string())?;
        }

        println!("[cloud_sync] complete (first sync), pulled (c={merged_c}, u={merged_u}, d={merged_d})");

        Ok(cloud_sync::CloudSyncSummary {
            pulled_created: merged_c,
            pulled_updated: merged_u,
            pulled_deleted: merged_d,
            pushed_created: 0,
            pushed_updated: 0,
            pushed_deleted: 0,
            new_timestamp: cloud_timestamp,
        })
    } else {
        // Normal sync: merge + gather in one transaction, then push.
        println!("[cloud_sync] phase 3-4a/5 merge + gather (single transaction)");
        let pre_gather_ts = timestamp();
        let ((merged_c, merged_u, merged_d), local_changes) = {
            let conn = open_encrypted_connection().map_err(|e| e.to_string())?;
            cloud_sync::phase_merge_and_gather(&conn, &cloud_changes, last_pulled_at)
                .map_err(|e| e.to_string())?
        };
        println!("[cloud_sync] phase 3-4a/5 complete, merged (c={merged_c}, u={merged_u}, d={merged_d})");

        let (pushed_c, pushed_u, pushed_d) = cloud_sync::count_changes(&local_changes);
        println!("[cloud_sync] phase 4b/5 pushing {pushed_c} created, {pushed_u} updated, {pushed_d} deleted");

        cloud_sync::phase_push(&cloud_url, &api_key, last_pulled_at, &local_changes)
            .await
            .map_err(|e| e.to_string())?;
        println!("[cloud_sync] phase 4b/5 complete");

        // Use min(cloud_timestamp, pre_gather_ts) so records written by
        // concurrent clients between pull and push aren't missed next cycle.
        let safe_watermark = cloud_timestamp.min(pre_gather_ts);
        println!("[cloud_sync] phase 5/5 updating watermark to {safe_watermark} (cloud={cloud_timestamp}, local={pre_gather_ts})");
        {
            let conn = open_encrypted_connection().map_err(|e| e.to_string())?;
            cloud_sync::phase_update_watermark(&conn, safe_watermark)
                .map_err(|e| e.to_string())?;
        }

        println!("[cloud_sync] complete, pulled (c={merged_c}, u={merged_u}, d={merged_d}), pushed (c={pushed_c}, u={pushed_u}, d={pushed_d})");

        Ok(cloud_sync::CloudSyncSummary {
            pulled_created: merged_c,
            pulled_updated: merged_u,
            pulled_deleted: merged_d,
            pushed_created: pushed_c,
            pushed_updated: pushed_u,
            pushed_deleted: pushed_d,
            new_timestamp: safe_watermark,
        })
    }
}

/// Get the current encryption key (internal use only, not exposed to frontend)
fn get_encryption_key(enc_state: &EncryptionState) -> Result<Vec<u8>, String> {
    enc_state
        .encryption_key
        .read()
        .clone()
        .ok_or_else(|| "Database is locked. Please unlock with passphrase.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // ========================================================================
    // timestamp()
    // ========================================================================

    #[test]
    fn timestamp_returns_positive_millis() {
        let ts = timestamp();
        // Should be a reasonable Unix epoch millis (after 2020-01-01)
        assert!(
            ts > 1_577_836_800_000,
            "timestamp should be after 2020-01-01"
        );
    }

    #[test]
    fn timestamp_is_monotonic() {
        let t1 = timestamp();
        let t2 = timestamp();
        assert!(t2 >= t1, "sequential timestamps should be non-decreasing");
    }

    // ========================================================================
    // SyncTableChangeSet
    // ========================================================================

    fn make_raw_record(id: &str, created_at: i64, updated_at: i64) -> RawRecord {
        RawRecord {
            id: id.to_string(),
            created_at,
            updated_at,
            data: HashMap::new(),
        }
    }

    #[test]
    fn sync_table_changeset_new_is_empty() {
        let cs = SyncTableChangeSet::new();
        assert!(cs.is_empty());
        assert_eq!(cs.total_changes(), 0);
    }

    #[test]
    fn sync_table_changeset_not_empty_with_created() {
        let cs = SyncTableChangeSet {
            created: vec![make_raw_record("r1", 100, 100)],
            updated: vec![],
            deleted: vec![],
        };
        assert!(!cs.is_empty());
        assert_eq!(cs.total_changes(), 1);
    }

    #[test]
    fn sync_table_changeset_not_empty_with_deleted() {
        let cs = SyncTableChangeSet {
            created: vec![],
            updated: vec![],
            deleted: vec!["d1".to_string()],
        };
        assert!(!cs.is_empty());
        assert_eq!(cs.total_changes(), 1);
    }

    #[test]
    fn sync_table_changeset_total_changes_sums_all() {
        let cs = SyncTableChangeSet {
            created: vec![
                make_raw_record("c1", 100, 100),
                make_raw_record("c2", 100, 100),
            ],
            updated: vec![make_raw_record("u1", 50, 100)],
            deleted: vec!["d1".to_string(), "d2".to_string(), "d3".to_string()],
        };
        assert_eq!(cs.total_changes(), 6);
    }

    #[test]
    fn filter_by_timestamp_separates_created_and_updated() {
        let cs = SyncTableChangeSet {
            created: vec![
                make_raw_record("new1", 200, 200),  // created_at >= 150 → created
                make_raw_record("old1", 100, 200),  // created_at < 150, updated_at >= 150 → updated
                make_raw_record("ancient", 50, 50), // created_at < 150, updated_at < 150 → excluded
            ],
            updated: vec![],
            deleted: vec!["del1".to_string()],
        };

        let filtered = cs.filter_by_timestamp(150);
        assert_eq!(filtered.created.len(), 1);
        assert_eq!(filtered.created[0].id, "new1");
        assert_eq!(filtered.updated.len(), 1);
        assert_eq!(filtered.updated[0].id, "old1");
        // Deletes are always included
        assert_eq!(filtered.deleted.len(), 1);
    }

    #[test]
    fn filter_by_timestamp_zero_returns_all_as_created() {
        let cs = SyncTableChangeSet {
            created: vec![
                make_raw_record("r1", 100, 200),
                make_raw_record("r2", 300, 400),
            ],
            updated: vec![],
            deleted: vec![],
        };

        let filtered = cs.filter_by_timestamp(0);
        // All records have created_at >= 0, so all go to "created"
        assert_eq!(filtered.created.len(), 2);
        assert!(filtered.updated.is_empty());
    }

    // ========================================================================
    // SyncDatabaseChangeSet
    // ========================================================================

    #[test]
    fn sync_database_changeset_new_is_empty() {
        let dbcs = SyncDatabaseChangeSet::new();
        assert!(dbcs.is_empty());
        assert!(dbcs.table_names().is_empty());
    }

    #[test]
    fn sync_database_changeset_add_empty_table_is_no_op() {
        let mut dbcs = SyncDatabaseChangeSet::new();
        dbcs.add_table_changes("patients", SyncTableChangeSet::new());
        // Empty changesets should not be inserted
        assert!(dbcs.is_empty());
        assert!(dbcs.get_table_changes("patients").is_none());
    }

    #[test]
    fn sync_database_changeset_add_nonempty_table() {
        let mut dbcs = SyncDatabaseChangeSet::new();
        let tc = SyncTableChangeSet {
            created: vec![make_raw_record("p1", 100, 100)],
            updated: vec![],
            deleted: vec![],
        };
        dbcs.add_table_changes("patients", tc);

        assert!(!dbcs.is_empty());
        assert_eq!(dbcs.table_names().len(), 1);
        let changes = dbcs.get_table_changes("patients").unwrap();
        assert_eq!(changes.created.len(), 1);
    }

    #[test]
    fn sync_database_changeset_multiple_tables() {
        let mut dbcs = SyncDatabaseChangeSet::new();
        dbcs.add_table_changes(
            "patients",
            SyncTableChangeSet {
                created: vec![make_raw_record("p1", 100, 100)],
                updated: vec![],
                deleted: vec![],
            },
        );
        dbcs.add_table_changes(
            "visits",
            SyncTableChangeSet {
                created: vec![],
                updated: vec![],
                deleted: vec!["v1".to_string()],
            },
        );

        assert_eq!(dbcs.table_names().len(), 2);
        assert!(dbcs.get_table_changes("nonexistent").is_none());
    }

    // ========================================================================
    // RawRecord serialization
    // ========================================================================

    #[test]
    fn raw_record_serde_roundtrip() {
        let mut data = HashMap::new();
        data.insert("custom".to_string(), serde_json::json!(42));

        let record = RawRecord {
            id: "ser1".to_string(),
            created_at: 1000,
            updated_at: 2000,
            data,
        };

        let json = serde_json::to_string(&record).unwrap();
        let deserialized: RawRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "ser1");
        assert_eq!(deserialized.created_at, 1000);
        assert_eq!(deserialized.updated_at, 2000);
    }

    #[test]
    fn raw_record_flattened_serialization() {
        let mut data = HashMap::new();
        data.insert("given_name".to_string(), serde_json::json!("Alice"));

        let record = RawRecord {
            id: "flat1".to_string(),
            created_at: 1000,
            updated_at: 2000,
            data,
        };

        let json_value: serde_json::Value = serde_json::to_value(&record).unwrap();
        // Due to #[serde(flatten)], given_name should be at top level
        assert_eq!(json_value["given_name"], "Alice");
        assert_eq!(json_value["id"], "flat1");
    }

    #[test]
    fn sync_database_changeset_serde_roundtrip() {
        let mut dbcs = SyncDatabaseChangeSet::new();
        dbcs.add_table_changes(
            "patients",
            SyncTableChangeSet {
                created: vec![make_raw_record("p1", 100, 200)],
                updated: vec![],
                deleted: vec!["d1".to_string()],
            },
        );

        let json = serde_json::to_string(&dbcs).unwrap();
        let deserialized: SyncDatabaseChangeSet = serde_json::from_str(&json).unwrap();
        let changes = deserialized.get_table_changes("patients").unwrap();
        assert_eq!(changes.created.len(), 1);
        assert_eq!(changes.deleted.len(), 1);
    }

    // ========================================================================
    // Property-based tests
    // ========================================================================

    proptest! {
        /// Property: total_changes equals sum of all three vectors
        #[test]
        fn total_changes_equals_sum(
            n_created in 0usize..20,
            n_updated in 0usize..20,
            n_deleted in 0usize..20,
        ) {
            let cs = SyncTableChangeSet {
                created: (0..n_created).map(|i| make_raw_record(&format!("c{}", i), 100, 200)).collect(),
                updated: (0..n_updated).map(|i| make_raw_record(&format!("u{}", i), 50, 200)).collect(),
                deleted: (0..n_deleted).map(|i| format!("d{}", i)).collect(),
            };
            prop_assert_eq!(cs.total_changes(), n_created + n_updated + n_deleted);
        }

        /// Property: is_empty iff total_changes == 0
        #[test]
        fn is_empty_iff_zero_changes(
            n_created in 0usize..10,
            n_updated in 0usize..10,
            n_deleted in 0usize..10,
        ) {
            let cs = SyncTableChangeSet {
                created: (0..n_created).map(|i| make_raw_record(&format!("c{}", i), 100, 200)).collect(),
                updated: (0..n_updated).map(|i| make_raw_record(&format!("u{}", i), 50, 200)).collect(),
                deleted: (0..n_deleted).map(|i| format!("d{}", i)).collect(),
            };
            prop_assert_eq!(cs.is_empty(), cs.total_changes() == 0);
        }

        /// Property: filter_by_timestamp never increases total record count (excluding deletes)
        #[test]
        fn filter_never_increases_record_count(
            records in prop::collection::vec(
                (1i64..10000, 1i64..10000),
                0..30
            ),
            threshold in 0i64..10000,
        ) {
            let cs = SyncTableChangeSet {
                created: records.iter().enumerate()
                    .map(|(i, &(c, u))| make_raw_record(&format!("r{}", i), c, u))
                    .collect(),
                updated: vec![],
                deleted: vec![],
            };

            let filtered = cs.filter_by_timestamp(threshold);
            let original_record_count = cs.created.len() + cs.updated.len();
            let filtered_record_count = filtered.created.len() + filtered.updated.len();
            prop_assert!(filtered_record_count <= original_record_count);
        }

        /// Property: filter_by_timestamp partitions correctly — every "created" record
        /// has created_at >= threshold
        #[test]
        fn filter_created_all_after_threshold(
            records in prop::collection::vec(
                (1i64..10000, 1i64..10000),
                1..20
            ),
            threshold in 0i64..10000,
        ) {
            let cs = SyncTableChangeSet {
                created: records.iter().enumerate()
                    .map(|(i, &(c, u))| make_raw_record(&format!("r{}", i), c, u))
                    .collect(),
                updated: vec![],
                deleted: vec![],
            };

            let filtered = cs.filter_by_timestamp(threshold);
            for rec in &filtered.created {
                prop_assert!(rec.created_at >= threshold,
                    "created record {} has created_at {} < threshold {}",
                    rec.id, rec.created_at, threshold);
            }
        }

        /// Property: filter_by_timestamp — every "updated" record has created_at < threshold
        /// and updated_at >= threshold
        #[test]
        fn filter_updated_correct_window(
            records in prop::collection::vec(
                (1i64..10000, 1i64..10000),
                1..20
            ),
            threshold in 1i64..10000,
        ) {
            let cs = SyncTableChangeSet {
                created: records.iter().enumerate()
                    .map(|(i, &(c, u))| make_raw_record(&format!("r{}", i), c, u))
                    .collect(),
                updated: vec![],
                deleted: vec![],
            };

            let filtered = cs.filter_by_timestamp(threshold);
            for rec in &filtered.updated {
                prop_assert!(rec.created_at < threshold,
                    "updated record {} has created_at {} >= threshold {}",
                    rec.id, rec.created_at, threshold);
                prop_assert!(rec.updated_at >= threshold,
                    "updated record {} has updated_at {} < threshold {}",
                    rec.id, rec.updated_at, threshold);
            }
        }

        /// Property: SyncDatabaseChangeSet roundtrips through serde
        #[test]
        fn database_changeset_serde_roundtrip(
            n_tables in 0usize..5,
            n_records in 0usize..5,
        ) {
            let mut dbcs = SyncDatabaseChangeSet::new();
            for t in 0..n_tables {
                let tc = SyncTableChangeSet {
                    created: (0..n_records)
                        .map(|i| make_raw_record(&format!("t{}_r{}", t, i), 100, 200))
                        .collect(),
                    updated: vec![],
                    deleted: vec![],
                };
                dbcs.add_table_changes(&format!("table_{}", t), tc);
            };

            let json = serde_json::to_string(&dbcs).unwrap();
            let deserialized: SyncDatabaseChangeSet = serde_json::from_str(&json).unwrap();

            // Tables with records should survive the roundtrip
            if n_records > 0 {
                prop_assert_eq!(deserialized.table_names().len(), n_tables);
            }
        }
    }

    // ========================================================================
    // Sync handler integration tests (using test_utils DB)
    // ========================================================================

    // ========================================================================
    // upsert_client_record / soft_delete_client_record
    // ========================================================================

    #[test]
    fn upsert_client_record_inserts_with_server_timestamps() {
        let conn = crate::test_utils::setup_test_db();
        let valid_columns = sync_utils::get_all_columns(&conn, "clinics").unwrap();
        let now = 9999;

        let mut data = HashMap::new();
        data.insert("name".to_string(), serde_json::json!("Test Clinic"));
        data.insert("is_deleted".to_string(), serde_json::json!(0));
        data.insert("is_archived".to_string(), serde_json::json!(0));

        let record = RawRecord {
            id: "c1".to_string(),
            created_at: 1000,
            updated_at: 2000,
            data,
        };

        upsert_client_record(&conn, "clinics", &record, &valid_columns, now).unwrap();

        let (lsca, lslm): (i64, i64) = conn
            .query_row(
                "SELECT local_server_created_at, local_server_last_modified_at FROM clinics WHERE id = 'c1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(lsca, now, "local_server_created_at should be now");
        assert_eq!(lslm, now, "local_server_last_modified_at should be now");

        let name: String = conn
            .query_row("SELECT name FROM clinics WHERE id = 'c1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "Test Clinic");
    }

    #[test]
    fn upsert_client_record_update_bumps_modified_preserves_created() {
        let conn = crate::test_utils::setup_test_db();
        let valid_columns = sync_utils::get_all_columns(&conn, "clinics").unwrap();

        // Insert initial record
        conn.execute(
            r#"INSERT INTO clinics (id, name, created_at, updated_at, is_deleted, is_archived,
                local_server_created_at, local_server_last_modified_at)
               VALUES ('c2', 'Original', 1000, 1000, 0, 0, 500, 500)"#,
            [],
        )
        .unwrap();

        // Upsert with new data
        let mut data = HashMap::new();
        data.insert("name".to_string(), serde_json::json!("Updated"));
        data.insert("is_deleted".to_string(), serde_json::json!(0));
        data.insert("is_archived".to_string(), serde_json::json!(0));

        let record = RawRecord {
            id: "c2".to_string(),
            created_at: 1000,
            updated_at: 3000,
            data,
        };

        upsert_client_record(&conn, "clinics", &record, &valid_columns, 8000).unwrap();

        let (lsca, lslm): (i64, i64) = conn
            .query_row(
                "SELECT local_server_created_at, local_server_last_modified_at FROM clinics WHERE id = 'c2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(lsca, 500, "local_server_created_at should be preserved");
        assert_eq!(
            lslm, 8000,
            "local_server_last_modified_at should be bumped to now"
        );

        let name: String = conn
            .query_row("SELECT name FROM clinics WHERE id = 'c2'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "Updated");
    }

    #[test]
    fn upsert_client_record_unknown_columns_skipped() {
        let conn = crate::test_utils::setup_test_db();
        let valid_columns = sync_utils::get_all_columns(&conn, "clinics").unwrap();

        let mut data = HashMap::new();
        data.insert("name".to_string(), serde_json::json!("Test"));
        data.insert("is_deleted".to_string(), serde_json::json!(0));
        data.insert("is_archived".to_string(), serde_json::json!(0));
        data.insert(
            "nonexistent_column".to_string(),
            serde_json::json!("ignored"),
        );

        let record = RawRecord {
            id: "c3".to_string(),
            created_at: 1000,
            updated_at: 2000,
            data,
        };

        // Should succeed without error
        upsert_client_record(&conn, "clinics", &record, &valid_columns, 9000).unwrap();

        let name: String = conn
            .query_row("SELECT name FROM clinics WHERE id = 'c3'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "Test");
    }

    #[test]
    fn soft_delete_client_record_sets_timestamps() {
        let conn = crate::test_utils::setup_test_db();

        conn.execute(
            r#"INSERT INTO clinics (id, name, created_at, updated_at, is_deleted, is_archived,
                local_server_created_at, local_server_last_modified_at)
               VALUES ('c-del', 'To Delete', 1000, 1000, 0, 0, 500, 500)"#,
            [],
        )
        .unwrap();

        soft_delete_client_record(&conn, "clinics", "c-del", 7777).unwrap();

        let (lslm, deleted_at): (i64, Option<i64>) = conn
            .query_row(
                "SELECT local_server_last_modified_at, local_server_deleted_at FROM clinics WHERE id = 'c-del'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(lslm, 7777, "local_server_last_modified_at should be bumped");
        assert_eq!(
            deleted_at,
            Some(7777),
            "local_server_deleted_at should be set"
        );
    }

    #[test]
    fn soft_delete_client_record_idempotent() {
        let conn = crate::test_utils::setup_test_db();

        conn.execute(
            r#"INSERT INTO clinics (id, name, created_at, updated_at, is_deleted, is_archived,
                local_server_created_at, local_server_last_modified_at, local_server_deleted_at)
               VALUES ('c-already', 'Already Deleted', 1000, 1000, 0, 0, 500, 600, 600)"#,
            [],
        )
        .unwrap();

        // Second delete should be a no-op (WHERE clause guards)
        soft_delete_client_record(&conn, "clinics", "c-already", 9999).unwrap();

        let (lslm, deleted_at): (i64, i64) = conn
            .query_row(
                "SELECT local_server_last_modified_at, local_server_deleted_at FROM clinics WHERE id = 'c-already'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(lslm, 600, "should not bump already-deleted record");
        assert_eq!(deleted_at, 600, "should preserve original deleted_at");
    }

    // Property test: client-written records MUST appear in the cloud push set.
    // This is the dual of cloud_sync::merge's "cloud records don't leak" invariant.
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(20))]
        #[test]
        fn client_written_records_appear_in_push_set(
            count in 1usize..=5,
            watermark in 1000i64..5000,
        ) {
            let conn = crate::test_utils::setup_test_db();
            let valid_columns = sync_utils::get_all_columns(&conn, "clinics").unwrap();

            // Use a "now" that is after the watermark
            let now = watermark + 1000;

            for i in 0..count {
                let mut data = HashMap::new();
                data.insert("name".to_string(), serde_json::json!(format!("Clinic {i}")));
                data.insert("is_deleted".to_string(), serde_json::json!(0));
                data.insert("is_archived".to_string(), serde_json::json!(0));

                let record = RawRecord {
                    id: format!("client-clinic-{i}"),
                    created_at: 1000,
                    updated_at: 2000,
                    data,
                };

                upsert_client_record(&conn, "clinics", &record, &valid_columns, now).unwrap();
            }

            // Gather local changes using a watermark that precedes the writes
            let local_changes = cloud_sync::push::gather_local_changes(&conn, watermark).unwrap();
            let clinics = local_changes.get_table_changes("clinics");

            prop_assert!(
                clinics.is_some(),
                "Client writes should appear in push set"
            );
            let clinics = clinics.unwrap();
            prop_assert_eq!(
                clinics.created.len(),
                count
            );
        }
    }
}
