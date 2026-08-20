// Pure JWT (HS256) implementation using ring::hmac.
//
// Manual base64url header.payload.signature construction — no external JWT crate.
// Tokens are fully offline: the local hub signs and verifies using a secret key
// stored in Stronghold.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::hmac;
use serde::{Deserialize, Serialize};

/// Default token time-to-live, matching the cloud server's `User.signIn`.
/// Clients recover from expiry via `AUTH_FAILED` -> `Peer.Hub.refreshToken`;
/// without that refresh, hub sync breaks every two hours.
const DEFAULT_TTL_SECS: i64 = 2 * 60 * 60;

/// Pre-computed base64url encoding of `{"alg":"HS256","typ":"JWT"}`
const HEADER_B64: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JwtError {
    MalformedToken,
    InvalidSignature,
    Expired,
    InvalidClaims(String),
}

impl std::fmt::Display for JwtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JwtError::MalformedToken => write!(f, "Malformed JWT token"),
            JwtError::InvalidSignature => write!(f, "Invalid JWT signature"),
            JwtError::Expired => write!(f, "JWT token has expired"),
            JwtError::InvalidClaims(msg) => write!(f, "Invalid JWT claims: {}", msg),
        }
    }
}

impl std::error::Error for JwtError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JwtClaims {
    pub sub: String, // user_id
    pub clinic_id: String,
    pub role: String,
    pub iat: i64, // issued at (epoch seconds)
    pub exp: i64, // expiry (epoch seconds)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl JwtClaims {
    /// Creates claims with the default expiry (`DEFAULT_TTL_SECS`) from now.
    pub fn new(user_id: String, clinic_id: String, role: String) -> Self {
        let now = now_secs();
        Self {
            sub: user_id,
            clinic_id,
            role,
            iat: now,
            exp: now + DEFAULT_TTL_SECS,
        }
    }

    /// Creates claims with a custom TTL (in seconds) from now.
    pub fn with_ttl(user_id: String, clinic_id: String, role: String, ttl_secs: i64) -> Self {
        let now = now_secs();
        Self {
            sub: user_id,
            clinic_id,
            role,
            iat: now,
            exp: now + ttl_secs,
        }
    }
}

/// Signs claims into a JWT string: `base64url(header).base64url(claims).base64url(signature)`
pub fn sign(claims: &JwtClaims, key: &[u8]) -> Result<String, JwtError> {
    let claims_json =
        serde_json::to_string(claims).map_err(|e| JwtError::InvalidClaims(e.to_string()))?;
    let claims_b64 = URL_SAFE_NO_PAD.encode(claims_json.as_bytes());

    let signing_input = format!("{}.{}", HEADER_B64, claims_b64);

    let hmac_key = hmac::Key::new(hmac::HMAC_SHA256, key);
    let signature = hmac::sign(&hmac_key, signing_input.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(signature.as_ref());

    Ok(format!("{}.{}", signing_input, sig_b64))
}

/// Verifies a JWT token and returns the claims if valid.
///
/// Checks: structure (3 parts), header match, HMAC signature, expiry.
pub fn verify(token: &str, key: &[u8]) -> Result<JwtClaims, JwtError> {
    let parts: Vec<&str> = token.splitn(3, '.').collect();
    if parts.len() != 3 {
        return Err(JwtError::MalformedToken);
    }

    let (header_b64, claims_b64, sig_b64) = (parts[0], parts[1], parts[2]);

    // Verify header matches our expected HS256 header
    if header_b64 != HEADER_B64 {
        return Err(JwtError::MalformedToken);
    }

    // Verify HMAC-SHA256 signature
    let signing_input = format!("{}.{}", header_b64, claims_b64);
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| JwtError::MalformedToken)?;

    let hmac_key = hmac::Key::new(hmac::HMAC_SHA256, key);
    hmac::verify(&hmac_key, signing_input.as_bytes(), &signature_bytes)
        .map_err(|_| JwtError::InvalidSignature)?;

    // Decode and parse claims
    let claims_bytes = URL_SAFE_NO_PAD
        .decode(claims_b64)
        .map_err(|_| JwtError::MalformedToken)?;
    let claims: JwtClaims = serde_json::from_slice(&claims_bytes)
        .map_err(|e| JwtError::InvalidClaims(e.to_string()))?;

    // Check expiry
    if claims.exp <= now_secs() {
        return Err(JwtError::Expired);
    }

    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const TEST_KEY: &[u8] = b"test-jwt-signing-key-32-bytes!!";

    #[test]
    fn sign_verify_roundtrip() {
        let claims = JwtClaims::new("user1".into(), "clinic1".into(), "admin".into());
        let token = sign(&claims, TEST_KEY).unwrap();
        let verified = verify(&token, TEST_KEY).unwrap();
        assert_eq!(verified.sub, "user1");
        assert_eq!(verified.clinic_id, "clinic1");
        assert_eq!(verified.role, "admin");
    }

    #[test]
    fn expired_token_rejected() {
        let claims = JwtClaims {
            sub: "user1".into(),
            clinic_id: "clinic1".into(),
            role: "admin".into(),
            iat: 1000,
            exp: 1001, // long expired
        };
        let token = sign(&claims, TEST_KEY).unwrap();
        let result = verify(&token, TEST_KEY);
        assert_eq!(result, Err(JwtError::Expired));
    }

    #[test]
    fn wrong_key_rejected() {
        let claims = JwtClaims::new("user1".into(), "clinic1".into(), "admin".into());
        let token = sign(&claims, TEST_KEY).unwrap();
        let result = verify(&token, b"wrong-key-wrong-key-wrong-key!!");
        assert_eq!(result, Err(JwtError::InvalidSignature));
    }

    #[test]
    fn tampered_payload_rejected() {
        let claims = JwtClaims::new("user1".into(), "clinic1".into(), "admin".into());
        let token = sign(&claims, TEST_KEY).unwrap();

        // Replace the claims section with different claims
        let parts: Vec<&str> = token.splitn(3, '.').collect();
        let fake_claims = JwtClaims::new("admin".into(), "all".into(), "superuser".into());
        let fake_json = serde_json::to_string(&fake_claims).unwrap();
        let fake_b64 = URL_SAFE_NO_PAD.encode(fake_json.as_bytes());
        let tampered = format!("{}.{}.{}", parts[0], fake_b64, parts[2]);

        let result = verify(&tampered, TEST_KEY);
        assert_eq!(result, Err(JwtError::InvalidSignature));
    }

    #[test]
    fn tampered_signature_rejected() {
        let claims = JwtClaims::new("user1".into(), "clinic1".into(), "admin".into());
        let token = sign(&claims, TEST_KEY).unwrap();

        // Flip bits in the signature
        let parts: Vec<&str> = token.splitn(3, '.').collect();
        let mut sig_bytes = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        sig_bytes[0] ^= 0xFF;
        let tampered_sig = URL_SAFE_NO_PAD.encode(&sig_bytes);
        let tampered = format!("{}.{}.{}", parts[0], parts[1], tampered_sig);

        let result = verify(&tampered, TEST_KEY);
        assert_eq!(result, Err(JwtError::InvalidSignature));
    }

    #[test]
    fn malformed_token_no_dots() {
        assert_eq!(verify("nodots", TEST_KEY), Err(JwtError::MalformedToken));
    }

    #[test]
    fn malformed_token_one_dot() {
        assert_eq!(verify("one.dot", TEST_KEY), Err(JwtError::MalformedToken));
    }

    #[test]
    fn malformed_token_wrong_header() {
        let result = verify("wrong_header.claims.sig", TEST_KEY);
        assert_eq!(result, Err(JwtError::MalformedToken));
    }

    #[test]
    fn empty_token_rejected() {
        assert_eq!(verify("", TEST_KEY), Err(JwtError::MalformedToken));
    }

    #[test]
    fn header_b64_constant_is_correct() {
        let header_json = r#"{"alg":"HS256","typ":"JWT"}"#;
        let expected = URL_SAFE_NO_PAD.encode(header_json.as_bytes());
        assert_eq!(HEADER_B64, expected);
    }

    // Pinned: drift back to 24h desyncs hub and cloud session lifetimes.
    #[test]
    fn default_ttl_is_two_hours() {
        assert_eq!(DEFAULT_TTL_SECS, 2 * 60 * 60);

        let claims = JwtClaims::new("u1".into(), "c1".into(), "admin".into());
        assert_eq!(claims.exp - claims.iat, 2 * 60 * 60);
    }

    #[test]
    fn claims_with_ttl() {
        let claims = JwtClaims::with_ttl("u1".into(), "c1".into(), "r1".into(), 3600);
        assert!(claims.exp - claims.iat == 3600);
    }

    #[test]
    fn jwt_error_display() {
        assert_eq!(JwtError::MalformedToken.to_string(), "Malformed JWT token");
        assert_eq!(
            JwtError::InvalidSignature.to_string(),
            "Invalid JWT signature"
        );
        assert_eq!(JwtError::Expired.to_string(), "JWT token has expired");
        assert_eq!(
            JwtError::InvalidClaims("bad".into()).to_string(),
            "Invalid JWT claims: bad"
        );
    }

    // ========================================================================
    // Property-based tests
    // ========================================================================

    proptest! {
        /// Property: sign → verify roundtrips for arbitrary valid claims
        #[test]
        fn roundtrip_arbitrary_claims(
            user_id in "[a-zA-Z0-9_-]{1,50}",
            clinic_id in "[a-zA-Z0-9_-]{1,50}",
            role in "[a-zA-Z0-9_-]{1,20}",
            key in prop::collection::vec(any::<u8>(), 16..64),
        ) {
            let claims = JwtClaims::new(user_id.clone(), clinic_id.clone(), role.clone());
            let token = sign(&claims, &key).unwrap();
            let verified = verify(&token, &key).unwrap();
            prop_assert_eq!(&verified.sub, &user_id);
            prop_assert_eq!(&verified.clinic_id, &clinic_id);
            prop_assert_eq!(&verified.role, &role);
        }

        /// Property: different keys never verify each other's tokens
        #[test]
        fn different_keys_reject(
            key1 in prop::collection::vec(any::<u8>(), 32..33),
            key2 in prop::collection::vec(any::<u8>(), 32..33),
        ) {
            prop_assume!(key1 != key2);
            let claims = JwtClaims::new("u".into(), "c".into(), "r".into());
            let token = sign(&claims, &key1).unwrap();
            let result = verify(&token, &key2);
            prop_assert_eq!(result, Err(JwtError::InvalidSignature));
        }

        /// Property: any past expiry is always rejected
        #[test]
        fn past_expiry_always_rejected(
            exp in 0i64..now_secs(),
        ) {
            let claims = JwtClaims {
                sub: "u".into(),
                clinic_id: "c".into(),
                role: "r".into(),
                iat: exp.saturating_sub(3600),
                exp,
            };
            let token = sign(&claims, TEST_KEY).unwrap();
            prop_assert_eq!(verify(&token, TEST_KEY), Err(JwtError::Expired));
        }

        /// Property: tokens with future expiry are accepted
        #[test]
        fn future_expiry_accepted(
            ttl in 60i64..86400,
        ) {
            let claims = JwtClaims::with_ttl("u".into(), "c".into(), "r".into(), ttl);
            let token = sign(&claims, TEST_KEY).unwrap();
            let result = verify(&token, TEST_KEY);
            prop_assert!(result.is_ok(), "token with {}s TTL should be valid", ttl);
        }

        /// Property: flipping any byte in the signature invalidates the token
        #[test]
        fn any_signature_byte_flip_invalidates(
            flip_idx in 0usize..32,
        ) {
            let claims = JwtClaims::new("u".into(), "c".into(), "r".into());
            let token = sign(&claims, TEST_KEY).unwrap();

            let parts: Vec<&str> = token.splitn(3, '.').collect();
            let mut sig_bytes = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
            sig_bytes[flip_idx] ^= 0x01;
            let tampered_sig = URL_SAFE_NO_PAD.encode(&sig_bytes);
            let tampered = format!("{}.{}.{}", parts[0], parts[1], tampered_sig);

            prop_assert_eq!(verify(&tampered, TEST_KEY), Err(JwtError::InvalidSignature));
        }
    }
}
