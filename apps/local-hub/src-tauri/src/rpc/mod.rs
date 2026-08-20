// CQRS RPC types and session management for encrypted client communication.
//
// Pure data structures and a thread-safe session registry.
// No HTTP handling — that lives in lib.rs Poem handlers.

pub mod auth;
pub mod handlers;

use crate::crypto::pairing::{PairingPublicKey, SharedSecret};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Newtype for a client identifier (opaque string chosen by the mobile app)
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ClientId(pub String);

/// A paired client session with its derived shared encryption key
pub struct ClientSession {
    pub client_id: ClientId,
    pub client_public_key: PairingPublicKey,
    pub shared_key: SharedSecret,
    pub paired_at: i64,
}

/// Thread-safe registry of paired client sessions.
///
/// Keyed by ClientId. Multiple concurrent readers, exclusive writer.
pub struct SessionRegistry {
    sessions: Arc<parking_lot::RwLock<HashMap<ClientId, ClientSession>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(parking_lot::RwLock::new(HashMap::new())),
        }
    }

    /// Registers a new client session, replacing any previous session for that client.
    pub fn register(&self, session: ClientSession) {
        self.sessions
            .write()
            .insert(session.client_id.clone(), session);
    }

    /// Retrieves a clone of the shared key for a given client.
    pub fn get_shared_key(&self, client_id: &ClientId) -> Option<SharedSecret> {
        self.sessions
            .read()
            .get(client_id)
            .map(|s| s.shared_key.clone())
    }

    /// Removes a client session, returning true if the client was registered.
    pub fn remove(&self, client_id: &ClientId) -> bool {
        self.sessions.write().remove(client_id).is_some()
    }

    /// Checks if a client is currently paired.
    pub fn is_paired(&self, client_id: &ClientId) -> bool {
        self.sessions.read().contains_key(client_id)
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ClientSession {
    pub fn new(
        client_id: ClientId,
        client_public_key: PairingPublicKey,
        shared_key: SharedSecret,
    ) -> Self {
        Self {
            client_id,
            client_public_key,
            shared_key,
            paired_at: now_millis(),
        }
    }
}

// -- Wire types for Poem JSON handlers --

/// POST /rpc/handshake request body
#[derive(Debug, Deserialize)]
pub struct HandshakeRequest {
    pub client_id: String,
    pub client_public_key: String, // base64url-encoded
    #[serde(default)]
    pub device_name: Option<String>,
}

/// POST /rpc/handshake response body
#[derive(Debug, Serialize)]
pub struct HandshakeResponse {
    pub hub_public_key: String, // base64url-encoded
    pub hub_id: String,
    pub hub_name: String,
    pub success: bool,
}

/// POST /rpc/command or /rpc/query encrypted envelope
#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub client_id: String,
    pub payload: String, // base64url(nonce ‖ ciphertext ‖ tag)
}

/// Decrypted inner payload for a command
#[derive(Debug, Deserialize)]
pub struct RpcCommandPayload {
    pub command: String,
    pub data: serde_json::Value,
    #[serde(default)]
    pub token: Option<String>,
}

/// Decrypted inner payload for a query
#[derive(Debug, Deserialize)]
pub struct RpcQueryPayload {
    pub query: String,
    pub params: serde_json::Value,
    #[serde(default)]
    pub token: Option<String>,
}

/// Encrypted RPC response
#[derive(Debug, Serialize)]
pub struct RpcResponse {
    pub payload: String, // base64url(nonce ‖ ciphertext ‖ tag) — absent on error
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Machine-readable classification of `error`.
    ///
    /// Errors travel as HTTP 200 with a plaintext `error`, so this is the only
    /// thing a client can branch on. Optional, so older clients are unaffected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

/// `error_code` value for a request whose token is missing, malformed, or expired.
pub const ERROR_CODE_AUTH_FAILED: &str = "AUTH_FAILED";

impl RpcResponse {
    pub fn success(payload: String) -> Self {
        Self {
            payload,
            success: true,
            error: None,
            error_code: None,
        }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            payload: String::new(),
            success: false,
            error: Some(msg.into()),
            error_code: None,
        }
    }

    /// An error the client is expected to recognise and handle.
    pub fn error_with_code(msg: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            payload: String::new(),
            success: false,
            error: Some(msg.into()),
            error_code: Some(code.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::pairing;

    #[test]
    fn session_registry_register_and_lookup() {
        let registry = SessionRegistry::new();
        let hub = pairing::generate_keypair();
        let client = pairing::generate_keypair();

        let shared =
            pairing::derive_shared_key(&hub.private_key_bytes, &client.public_key, &hub.public_key)
                .unwrap();

        let client_id = ClientId("test-client".to_string());
        assert!(!registry.is_paired(&client_id));

        registry.register(ClientSession::new(
            client_id.clone(),
            client.public_key,
            shared.clone(),
        ));

        assert!(registry.is_paired(&client_id));
        let retrieved = registry.get_shared_key(&client_id).unwrap();
        assert_eq!(retrieved.0, shared.0);
    }

    #[test]
    fn session_registry_remove() {
        let registry = SessionRegistry::new();
        let hub = pairing::generate_keypair();
        let client = pairing::generate_keypair();

        let shared =
            pairing::derive_shared_key(&hub.private_key_bytes, &client.public_key, &hub.public_key)
                .unwrap();

        let client_id = ClientId("removable".to_string());
        registry.register(ClientSession::new(
            client_id.clone(),
            client.public_key,
            shared,
        ));

        assert!(registry.remove(&client_id));
        assert!(!registry.is_paired(&client_id));
        assert!(registry.get_shared_key(&client_id).is_none());
    }

    #[test]
    fn rpc_response_constructors() {
        let ok = RpcResponse::success("payload".to_string());
        assert!(ok.success);
        assert!(ok.error.is_none());

        let err = RpcResponse::error("something broke");
        assert!(!err.success);
        assert_eq!(err.error.as_deref(), Some("something broke"));
    }

    #[test]
    fn session_registry_replace_on_re_register() {
        let registry = SessionRegistry::new();
        let hub = pairing::generate_keypair();
        let client1 = pairing::generate_keypair();
        let client2 = pairing::generate_keypair();

        let shared1 = pairing::derive_shared_key(
            &hub.private_key_bytes,
            &client1.public_key,
            &hub.public_key,
        )
        .unwrap();
        let shared2 = pairing::derive_shared_key(
            &hub.private_key_bytes,
            &client2.public_key,
            &hub.public_key,
        )
        .unwrap();

        let client_id = ClientId("same-id".to_string());

        // Register with first shared key
        registry.register(ClientSession::new(
            client_id.clone(),
            client1.public_key,
            shared1.clone(),
        ));
        let key1 = registry.get_shared_key(&client_id).unwrap();
        assert_eq!(key1.0, shared1.0);

        // Re-register with second shared key — should replace
        registry.register(ClientSession::new(
            client_id.clone(),
            client2.public_key,
            shared2.clone(),
        ));
        let key2 = registry.get_shared_key(&client_id).unwrap();
        assert_eq!(key2.0, shared2.0);
    }

    #[test]
    fn session_registry_remove_nonexistent_returns_false() {
        let registry = SessionRegistry::new();
        let result = registry.remove(&ClientId("ghost".to_string()));
        assert!(!result);
    }

    #[test]
    fn session_registry_get_shared_key_nonexistent_returns_none() {
        let registry = SessionRegistry::new();
        assert!(registry
            .get_shared_key(&ClientId("missing".to_string()))
            .is_none());
    }

    #[test]
    fn rpc_response_success_serialization() {
        let resp = RpcResponse::success("data".to_string());
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["success"], true);
        assert_eq!(json["payload"], "data");
        // error should be absent (skip_serializing_if)
        assert!(json.get("error").is_none());
    }

    #[test]
    fn rpc_response_error_serialization() {
        let resp = RpcResponse::error("bad request");
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["success"], false);
        assert_eq!(json["error"], "bad request");
    }

    #[test]
    fn client_session_has_reasonable_paired_at() {
        let hub = pairing::generate_keypair();
        let client = pairing::generate_keypair();
        let shared =
            pairing::derive_shared_key(&hub.private_key_bytes, &client.public_key, &hub.public_key)
                .unwrap();

        let session =
            ClientSession::new(ClientId("ts-test".to_string()), client.public_key, shared);
        // paired_at should be a reasonable recent timestamp
        assert!(session.paired_at > 1_577_836_800_000); // after 2020-01-01
    }

    // ========================================================================
    // Property-based tests
    // ========================================================================

    use proptest::prelude::*;

    proptest! {
        /// Property: registering N distinct clients means N are paired
        #[test]
        fn register_n_clients_all_paired(n in 1u32..20) {
            let registry = SessionRegistry::new();
            let hub = pairing::generate_keypair();

            for i in 0..n {
                let client = pairing::generate_keypair();
                let shared = pairing::derive_shared_key(
                    &hub.private_key_bytes,
                    &client.public_key,
                    &hub.public_key,
                ).unwrap();

                let id = ClientId(format!("client_{}", i));
                registry.register(ClientSession::new(id, client.public_key, shared));
            }

            for i in 0..n {
                let id = ClientId(format!("client_{}", i));
                prop_assert!(registry.is_paired(&id), "client_{} should be paired", i);
                prop_assert!(registry.get_shared_key(&id).is_some());
            }
        }

        /// Property: removing a client makes it no longer paired while others remain
        #[test]
        fn remove_one_preserves_others(n in 2u32..10) {
            let registry = SessionRegistry::new();
            let hub = pairing::generate_keypair();

            for i in 0..n {
                let client = pairing::generate_keypair();
                let shared = pairing::derive_shared_key(
                    &hub.private_key_bytes,
                    &client.public_key,
                    &hub.public_key,
                ).unwrap();
                registry.register(ClientSession::new(
                    ClientId(format!("c{}", i)),
                    client.public_key,
                    shared,
                ));
            }

            // Remove the first client
            let removed_id = ClientId("c0".to_string());
            prop_assert!(registry.remove(&removed_id));
            prop_assert!(!registry.is_paired(&removed_id));

            // All others should still be paired
            for i in 1..n {
                let id = ClientId(format!("c{}", i));
                prop_assert!(registry.is_paired(&id), "c{} should still be paired after removing c0", i);
            }
        }
    }
}
