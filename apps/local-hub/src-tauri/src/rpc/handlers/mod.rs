// RPC command and query dispatch.
//
// Each domain module owns its payload types and handler functions.
// This module provides the dispatch routing, JWT auth gating, and shared helpers.
// AuthContext is kept after authentication and threaded through to handlers
// so they can perform per-clinic permission checks.

mod appointments;
pub(crate) mod auth;
mod clinics;
pub(crate) mod data;
mod dispensing;
mod drugs;
mod forms;
mod inventory;
mod patients;
mod prescription_items;
mod prescriptions;
pub(crate) mod serde_flexible;
pub(crate) mod sync;
mod visits;

use rusqlite::Connection;
use serde::Serialize;

use super::{RpcCommandPayload, RpcQueryPayload};
pub type HandlerResult = Result<serde_json::Value, Box<dyn std::error::Error>>;

fn default_limit() -> i64 {
    20
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Serialize)]
struct PaginatedResponse<T: Serialize> {
    data: Vec<T>,
    total: i64,
    limit: i64,
    offset: i64,
}

/// Dispatches a command to the appropriate domain handler.
///
/// Exempt commands (ping, login) bypass JWT. All others require a valid token,
/// and the resulting AuthContext is passed through to handlers for permission checks.
pub fn dispatch_command(
    cmd: &RpcCommandPayload,
    conn: &Connection,
    jwt_key: Option<&[u8]>,
) -> serde_json::Value {
    println!("[rpc_command] received command=\"{}\"", cmd.command);

    // Exempt commands — no JWT required
    match cmd.command.as_str() {
        "ping" => {
            println!("[rpc_command] exempt command, responding with pong");
            return serde_json::json!({ "pong": true });
        }
        "login" => {
            println!("[rpc_command] exempt command, processing login");
            return match jwt_key {
                Some(key) => try_handle(|| auth::handle_login(&cmd.data, conn, key)),
                None => {
                    eprintln!("[rpc_command] login failed: server not fully initialized");
                    serde_json::json!({ "error": "Server not fully initialized" })
                }
            };
        }
        _ => {}
    }

    // All other commands require JWT authentication
    let jwt_key = match jwt_key {
        Some(k) => k,
        None => {
            eprintln!(
                "[rpc_command] rejected \"{}\": server not fully initialized",
                cmd.command
            );
            return serde_json::json!({ "error": "Server not fully initialized" });
        }
    };
    let token = match &cmd.token {
        Some(t) => t,
        None => {
            eprintln!(
                "[rpc_command] rejected \"{}\": no token provided",
                cmd.command
            );
            return auth_error("Authentication required");
        }
    };
    let auth_ctx = match crate::rpc::auth::authenticate(token, jwt_key, conn) {
        Ok(ctx) => ctx,
        Err(e) => {
            eprintln!(
                "[rpc_command] rejected \"{}\": auth failed — {e}",
                cmd.command
            );
            return auth_error(e);
        }
    };

    println!("[rpc_command] auth OK, dispatching \"{}\"", cmd.command);

    // Dispatch to domain handlers — auth context threaded through
    let result = match cmd.command.as_str() {
        "register_patient" => try_handle(|| {
            println!(
                "[register_patient] raw cmd.data: {}",
                serde_json::to_string_pretty(&cmd.data).unwrap_or_default()
            );

            // Try to deserialize and log detailed error on failure
            let payload: patients::RegisterPatientCommand = match serde_json::from_value(
                cmd.data.clone(),
            ) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[register_patient] deserialization failed: {e}");
                    // Drill into the patient sub-object to find the offending field
                    if let Some(patient_obj) = cmd.data.get("patient") {
                        for (key, val) in patient_obj.as_object().into_iter().flatten() {
                            let kind = match val {
                                serde_json::Value::Null => "null",
                                serde_json::Value::Bool(_) => "bool",
                                serde_json::Value::Number(_) => "number",
                                serde_json::Value::String(_) => "string",
                                serde_json::Value::Array(_) => "array",
                                serde_json::Value::Object(_) => "object/map",
                            };
                            println!("[register_patient]   patient.{key} = {kind} → {val}");
                        }
                    }
                    if let Some(attrs) = cmd.data.get("additional_attributes") {
                        println!(
                            "[register_patient]   additional_attributes type: {}",
                            if attrs.is_array() { "array" } else { "other" }
                        );
                        if let Some(arr) = attrs.as_array() {
                            for (i, attr) in arr.iter().enumerate() {
                                for (key, val) in attr.as_object().into_iter().flatten() {
                                    let kind = match val {
                                        serde_json::Value::Null => "null",
                                        serde_json::Value::Bool(_) => "bool",
                                        serde_json::Value::Number(_) => "number",
                                        serde_json::Value::String(_) => "string",
                                        serde_json::Value::Array(_) => "array",
                                        serde_json::Value::Object(_) => "object/map",
                                    };
                                    println!("[register_patient]   additional_attributes[{i}].{key} = {kind} → {val}");
                                }
                            }
                        }
                    }
                    return Err(e.into());
                }
            };
            patients::handle_register_patient(&payload, conn, &auth_ctx)
        }),
        "delete_patient" => try_handle(|| {
            let payload: patients::DeletePatientCommand = serde_json::from_value(cmd.data.clone())?;
            patients::handle_delete_patient(&payload, conn, &auth_ctx)
        }),
        "create_event" => try_handle(|| {
            let payload: visits::CreateEventCommand = serde_json::from_value(cmd.data.clone())?;
            visits::handle_create_event(&payload, conn)
        }),
        "sync_push" => try_handle(|| {
            let payload: sync::SyncPushPayload = serde_json::from_value(cmd.data.clone())?;
            sync::handle_sync_push(&payload, conn)
        }),
        // Visit & vitals updates
        "visits.update" => try_handle(|| {
            let payload: visits::UpdateVisitCommand = serde_json::from_value(cmd.data.clone())?;
            visits::handle_update_visit(&payload, conn)
        }),
        "vitals.create" => try_handle(|| {
            let payload: visits::CreateVitalsCommand = serde_json::from_value(cmd.data.clone())?;
            visits::handle_create_vitals(&payload, conn)
        }),
        "vitals.update" => try_handle(|| {
            let payload: visits::UpdateVitalsCommand = serde_json::from_value(cmd.data.clone())?;
            visits::handle_update_vitals(&payload, conn)
        }),
        // Appointments
        "appointments.create" => try_handle(|| {
            let payload: appointments::CreateAppointmentCommand =
                serde_json::from_value(cmd.data.clone())?;
            appointments::handle_create_appointment(&payload, conn)
        }),
        "appointments.update" => try_handle(|| {
            let payload: appointments::UpdateAppointmentCommand =
                serde_json::from_value(cmd.data.clone())?;
            appointments::handle_update_appointment(&payload, conn)
        }),
        "appointments.cancel" => try_handle(|| {
            let payload: appointments::CancelAppointmentCommand =
                serde_json::from_value(cmd.data.clone())?;
            appointments::handle_cancel_appointment(&payload, conn)
        }),
        "appointments.complete" => try_handle(|| {
            let payload: appointments::CompleteAppointmentCommand =
                serde_json::from_value(cmd.data.clone())?;
            appointments::handle_complete_appointment(&payload, conn)
        }),
        // Prescriptions
        "prescriptions.create" => try_handle(|| {
            let payload: prescriptions::CreatePrescriptionCommand =
                serde_json::from_value(cmd.data.clone())?;
            prescriptions::handle_create_prescription(&payload, conn)
        }),
        "prescriptions.update" => try_handle(|| {
            let payload: prescriptions::UpdatePrescriptionCommand =
                serde_json::from_value(cmd.data.clone())?;
            prescriptions::handle_update_prescription(&payload, conn)
        }),
        "prescriptions.update_status" => try_handle(|| {
            let payload: prescriptions::UpdatePrescriptionStatusCommand =
                serde_json::from_value(cmd.data.clone())?;
            prescriptions::handle_update_prescription_status(&payload, conn)
        }),
        "prescriptions.pickup" => try_handle(|| {
            let payload: prescriptions::PickupPrescriptionCommand =
                serde_json::from_value(cmd.data.clone())?;
            prescriptions::handle_pickup_prescription(&payload, conn)
        }),
        // Prescription items
        "prescription_items.create" => try_handle(|| {
            let payload: prescription_items::CreatePrescriptionItemCommand =
                serde_json::from_value(cmd.data.clone())?;
            prescription_items::handle_create_prescription_item(&payload, conn)
        }),
        "prescription_items.update" => try_handle(|| {
            let payload: prescription_items::UpdatePrescriptionItemCommand =
                serde_json::from_value(cmd.data.clone())?;
            prescription_items::handle_update_prescription_item(&payload, conn)
        }),
        "prescription_items.dispense" => try_handle(|| {
            let payload: prescription_items::DispensePrescriptionItemCommand =
                serde_json::from_value(cmd.data.clone())?;
            prescription_items::handle_dispense_prescription_item(&payload, conn)
        }),
        // Dispensing
        "dispensing.create" => try_handle(|| {
            let payload: dispensing::CreateDispensingCommand =
                serde_json::from_value(cmd.data.clone())?;
            dispensing::handle_create_dispensing(&payload, conn)
        }),
        other => {
            eprintln!("[rpc_command] unknown command: {other}");
            serde_json::json!({ "error": format!("Unknown command: {other}") })
        }
    };

    if result.get("error").is_some() {
        eprintln!(
            "[rpc_command] \"{}\" returned error: {}",
            cmd.command, result["error"]
        );
    } else {
        println!("[rpc_command] \"{}\" completed successfully", cmd.command);
    }

    result
}

/// Dispatches a query to the appropriate domain handler.
///
/// Exempt queries (ping, heartbeat) bypass JWT. All others require a valid token,
/// and the resulting AuthContext is passed through to handlers for permission checks.
pub fn dispatch_query(
    qry: &RpcQueryPayload,
    conn: &Connection,
    jwt_key: Option<&[u8]>,
) -> serde_json::Value {
    println!("[rpc_query] received query=\"{}\"", qry.query);

    // Exempt queries — no JWT required
    match qry.query.as_str() {
        "ping" => {
            println!("[rpc_query] exempt query, responding with pong");
            return serde_json::json!({ "pong": true });
        }
        "heartbeat" => {
            println!("[rpc_query] exempt query, responding with heartbeat");
            return serde_json::json!({ "status": "ok" });
        }
        _ => {}
    }

    // All other queries require JWT authentication
    let jwt_key = match jwt_key {
        Some(k) => k,
        None => {
            eprintln!(
                "[rpc_query] rejected \"{}\": server not fully initialized",
                qry.query
            );
            return serde_json::json!({ "error": "Server not fully initialized" });
        }
    };
    let token = match &qry.token {
        Some(t) => t,
        None => {
            eprintln!("[rpc_query] rejected \"{}\": no token provided", qry.query);
            return auth_error("Authentication required");
        }
    };
    let auth_ctx = match crate::rpc::auth::authenticate(token, jwt_key, conn) {
        Ok(ctx) => ctx,
        Err(e) => {
            eprintln!("[rpc_query] rejected \"{}\": auth failed — {e}", qry.query);
            return auth_error(e);
        }
    };

    println!("[rpc_query] auth OK, dispatching \"{}\"", qry.query);

    // Dispatch to domain handlers — auth context threaded through
    let result = match qry.query.as_str() {
        "get_patient" => try_handle(|| {
            let payload: patients::GetPatientQuery = serde_json::from_value(qry.params.clone())?;
            patients::handle_get_patient(&payload, conn, &auth_ctx)
        }),
        "search_patients" => try_handle(|| {
            let payload: patients::SearchPatientsQuery =
                serde_json::from_value(qry.params.clone())?;
            patients::handle_search_patients(&payload, conn, &auth_ctx)
        }),
        "get_patients" => try_handle(|| {
            let payload: patients::GetPatientsListQuery =
                serde_json::from_value(qry.params.clone())?;
            patients::handle_get_patients(&payload, conn, &auth_ctx)
        }),
        "check_government_id" => try_handle(|| {
            let payload: patients::CheckGovernmentIdQuery =
                serde_json::from_value(qry.params.clone())?;
            patients::handle_check_government_id(&payload, conn)
        }),
        "get_visits" => try_handle(|| {
            let payload: visits::GetVisitsQuery = serde_json::from_value(qry.params.clone())?;
            visits::handle_get_visits(&payload, conn)
        }),
        "get_visit_events" => try_handle(|| {
            let payload: visits::GetVisitEventsQuery = serde_json::from_value(qry.params.clone())?;
            visits::handle_get_visit_events(&payload, conn)
        }),
        "vitals.list" => try_handle(|| {
            let payload: visits::ListVitalsQuery = serde_json::from_value(qry.params.clone())?;
            visits::handle_list_vitals(&payload, conn)
        }),
        "get_patient_registration_form" => {
            try_handle(|| forms::handle_get_patient_registration_form(conn))
        }
        "get_all_registration_forms" => {
            try_handle(|| patients::handle_get_all_registration_forms(conn))
        }
        "get_event_forms" => try_handle(|| forms::handle_get_event_forms(conn)),
        "get_event_form" => try_handle(|| {
            let payload: forms::GetEventFormQuery = serde_json::from_value(qry.params.clone())?;
            forms::handle_get_event_form(&payload, conn)
        }),
        "sync_pull" => try_handle(|| {
            let payload: sync::SyncPullParams = serde_json::from_value(qry.params.clone())?;
            sync::handle_sync_pull(&payload, conn)
        }),
        // Clinics & departments
        "clinics.list" => try_handle(|| clinics::handle_list_clinics(conn)),
        "clinic_departments.list" => try_handle(|| {
            let payload: clinics::ListClinicDepartmentsQuery =
                serde_json::from_value(qry.params.clone())?;
            clinics::handle_list_clinic_departments(&payload, conn)
        }),
        // Forms (new dot-notation aliases with filtering)
        "event_forms.list" => try_handle(|| {
            let payload: forms::ListEventFormsQuery =
                serde_json::from_value(qry.params.clone())?;
            forms::handle_list_event_forms(&payload, conn)
        }),
        "registration_form.get" => try_handle(|| {
            let payload: forms::GetRegistrationFormQuery =
                serde_json::from_value(qry.params.clone())?;
            forms::handle_get_registration_form(&payload, conn)
        }),
        // Similar patient search
        "patients.similar" => try_handle(|| {
            let payload: patients::SimilarPatientsQuery =
                serde_json::from_value(qry.params.clone())?;
            patients::handle_similar_patients(&payload, conn, &auth_ctx)
        }),
        // Appointments
        "appointments.list" => try_handle(|| {
            let payload: appointments::ListAppointmentsQuery =
                serde_json::from_value(qry.params.clone())?;
            appointments::handle_list_appointments(&payload, conn)
        }),
        "appointments.get" => try_handle(|| {
            let payload: appointments::GetAppointmentQuery =
                serde_json::from_value(qry.params.clone())?;
            appointments::handle_get_appointment(&payload, conn)
        }),
        "appointments.by_patient" => try_handle(|| {
            let payload: appointments::GetPatientAppointmentsQuery =
                serde_json::from_value(qry.params.clone())?;
            appointments::handle_get_patient_appointments(&payload, conn)
        }),
        "appointments.search" => try_handle(|| {
            let payload: appointments::SearchAppointmentsQuery =
                serde_json::from_value(qry.params.clone())?;
            appointments::handle_search_appointments(&payload, conn)
        }),
        // Prescriptions
        "prescriptions.search" => try_handle(|| {
            let payload: prescriptions::SearchPrescriptionsQuery =
                serde_json::from_value(qry.params.clone())?;
            prescriptions::handle_search_prescriptions(&payload, conn)
        }),
        "prescriptions.by_patient_visit" => try_handle(|| {
            let payload: prescriptions::PrescriptionsByPatientVisitQuery =
                serde_json::from_value(qry.params.clone())?;
            prescriptions::handle_prescriptions_by_patient_visit(&payload, conn)
        }),
        // Prescription items
        "prescription_items.by_prescription" => try_handle(|| {
            let payload: prescription_items::ItemsByPrescriptionQuery =
                serde_json::from_value(qry.params.clone())?;
            prescription_items::handle_items_by_prescription(&payload, conn)
        }),
        "prescription_items.by_patient" => try_handle(|| {
            let payload: prescription_items::ItemsByPatientQuery =
                serde_json::from_value(qry.params.clone())?;
            prescription_items::handle_items_by_patient(&payload, conn)
        }),
        // Drug catalogue
        "drugs.search" => try_handle(|| {
            let payload: drugs::SearchDrugsQuery =
                serde_json::from_value(qry.params.clone())?;
            drugs::handle_search_drugs(&payload, conn)
        }),
        "drugs.get" => try_handle(|| {
            let payload: drugs::GetDrugQuery =
                serde_json::from_value(qry.params.clone())?;
            drugs::handle_get_drug(&payload, conn)
        }),
        "drugs.by_barcode" => try_handle(|| {
            let payload: drugs::GetDrugByBarcodeQuery =
                serde_json::from_value(qry.params.clone())?;
            drugs::handle_get_drug_by_barcode(&payload, conn)
        }),
        // Inventory
        "inventory.by_clinic" => try_handle(|| {
            let payload: inventory::InventoryByClinicQuery =
                serde_json::from_value(qry.params.clone())?;
            inventory::handle_inventory_by_clinic(&payload, conn)
        }),
        "inventory.search" => try_handle(|| {
            let payload: inventory::InventorySearchQuery =
                serde_json::from_value(qry.params.clone())?;
            inventory::handle_inventory_search(&payload, conn)
        }),
        "inventory.check_availability" => try_handle(|| {
            let payload: inventory::CheckAvailabilityQuery =
                serde_json::from_value(qry.params.clone())?;
            inventory::handle_check_availability(&payload, conn)
        }),
        // Dispensing
        "dispensing.by_patient" => try_handle(|| {
            let payload: dispensing::DispensingByPatientQuery =
                serde_json::from_value(qry.params.clone())?;
            dispensing::handle_dispensing_by_patient(&payload, conn)
        }),
        other => {
            eprintln!("[rpc_query] unknown query: {other}");
            serde_json::json!({ "error": format!("Unknown query: {other}") })
        }
    };

    if result.get("error").is_some() {
        eprintln!(
            "[rpc_query] \"{}\" returned error: {}",
            qry.query, result["error"]
        );
    } else {
        println!("[rpc_query] \"{}\" completed successfully", qry.query);
    }

    result
}

/// An auth rejection, tagged so the client refreshes its token instead of
/// stranding the user. The message is still what gets logged and shown.
fn auth_error(message: impl Into<String>) -> serde_json::Value {
    serde_json::json!({
        "error": message.into(),
        "error_code": crate::rpc::ERROR_CODE_AUTH_FAILED,
    })
}

/// Runs a fallible handler, converting errors to a JSON error object.
fn try_handle<F>(f: F) -> serde_json::Value
where
    F: FnOnce() -> Result<serde_json::Value, Box<dyn std::error::Error>>,
{
    match f() {
        Ok(v) => v,
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::jwt;
    use crate::test_utils::setup_test_db;

    const TEST_JWT_KEY: &[u8] = b"test-jwt-signing-key-32-bytes!!";

    /// Creates a valid JWT token for tests.
    fn make_test_token(user_id: &str, clinic_id: &str) -> String {
        let claims = jwt::JwtClaims::new(
            user_id.to_string(),
            clinic_id.to_string(),
            "admin".to_string(),
        );
        jwt::sign(&claims, TEST_JWT_KEY).unwrap()
    }

    /// Inserts a clinic, user, and permissions rows needed for JWT auth to succeed.
    fn insert_test_user_and_permissions(conn: &Connection, user_id: &str, clinic_id: &str) {
        let now = 1000i64;
        let hashed = crate::test_utils::hash_password_for_test("test-password");

        conn.execute(
            "INSERT INTO clinics (id, name, is_deleted, is_archived, attributes, metadata,
                                  created_at, updated_at,
                                  local_server_created_at, local_server_last_modified_at)
             VALUES (?1, 'Test Clinic', 0, 0, '[]', '{}', ?2, ?2, ?2, ?2)",
            rusqlite::params![clinic_id, now],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO users (id, clinic_id, name, role, email, hashed_password,
                                created_at, updated_at, is_deleted,
                                local_server_created_at, local_server_last_modified_at)
             VALUES (?1, ?2, 'Test User', 'admin', 'test@example.com', ?4,
                     ?3, ?3, 0, ?3, ?3)",
            rusqlite::params![user_id, clinic_id, now, hashed],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO user_clinic_permissions
                (id, user_id, clinic_id,
                 can_register_patients, can_view_history, can_edit_records,
                 can_delete_records, is_clinic_admin, can_edit_other_provider_event,
                 can_download_patient_reports, can_prescribe_medications,
                 can_dispense_medications, can_delete_patient_visits,
                 can_delete_patient_records,
                 created_at, updated_at,
                 local_server_created_at, local_server_last_modified_at)
             VALUES ('perm1', ?1, ?2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
                     ?3, ?3, ?3, ?3)",
            rusqlite::params![user_id, clinic_id, now],
        )
        .unwrap();
    }

    // ========================================================================
    // Exempt command/query tests (no JWT needed)
    // ========================================================================

    #[test]
    fn dispatch_ping_command() {
        let conn = setup_test_db();
        let cmd = RpcCommandPayload {
            command: "ping".to_string(),
            data: serde_json::json!({}),
            token: None,
        };
        let result = dispatch_command(&cmd, &conn, None);
        assert_eq!(result["pong"], true);
    }

    #[test]
    fn dispatch_heartbeat_query() {
        let conn = setup_test_db();
        let qry = RpcQueryPayload {
            query: "heartbeat".to_string(),
            params: serde_json::json!({}),
            token: None,
        };
        let result = dispatch_query(&qry, &conn, None);
        assert_eq!(result["status"], "ok");
    }

    // ========================================================================
    // Auth-gated command/query tests
    // ========================================================================

    #[test]
    fn dispatch_unauthenticated_command_rejected() {
        let conn = setup_test_db();
        let cmd = RpcCommandPayload {
            command: "register_patient".to_string(),
            data: serde_json::json!({}),
            token: None,
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("Authentication required"));
    }

    // Only one of these two is worth a retry, so they must be distinguishable.
    #[test]
    fn dispatch_unauthenticated_command_is_tagged_auth_failed() {
        let conn = setup_test_db();
        let cmd = RpcCommandPayload {
            command: "register_patient".to_string(),
            data: serde_json::json!({}),
            token: None,
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert_eq!(result["error_code"], crate::rpc::ERROR_CODE_AUTH_FAILED);
    }

    #[test]
    fn dispatch_unauthenticated_query_is_tagged_auth_failed() {
        let conn = setup_test_db();
        let qry = RpcQueryPayload {
            query: "get_patients".to_string(),
            params: serde_json::json!({}),
            token: None,
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert_eq!(result["error_code"], crate::rpc::ERROR_CODE_AUTH_FAILED);
    }

    // An expired token means "refresh and retry", not "sign in again".
    #[test]
    fn dispatch_expired_token_is_tagged_auth_failed() {
        let conn = setup_test_db();
        let expired = crate::crypto::jwt::JwtClaims {
            sub: "u1".into(),
            clinic_id: "c1".into(),
            role: "admin".into(),
            iat: 1000,
            exp: 1001,
        };
        let token = crate::crypto::jwt::sign(&expired, TEST_JWT_KEY).unwrap();
        let qry = RpcQueryPayload {
            query: "get_patients".to_string(),
            params: serde_json::json!({}),
            token: Some(token),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));

        assert_eq!(result["error_code"], crate::rpc::ERROR_CODE_AUTH_FAILED);
        assert!(result["error"].as_str().unwrap().contains("expired"));
    }

    // A non-auth failure must not be tagged, or the client refreshes forever.
    // Authenticated on purpose, or auth rejects before the unknown-query branch.
    #[test]
    fn dispatch_unknown_query_is_not_tagged_auth_failed() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let qry = RpcQueryPayload {
            query: "no_such_query".to_string(),
            params: serde_json::json!({}),
            token: Some(make_test_token("u1", "c1")),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));

        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("Unknown query"));
        assert!(result.get("error_code").is_none());
    }

    #[test]
    fn dispatch_unauthenticated_query_rejected() {
        let conn = setup_test_db();
        let qry = RpcQueryPayload {
            query: "get_patients".to_string(),
            params: serde_json::json!({}),
            token: None,
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("Authentication required"));
    }

    #[test]
    fn dispatch_unknown_command_with_auth() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let cmd = RpcCommandPayload {
            command: "does_not_exist".to_string(),
            data: serde_json::json!({}),
            token: Some(token),
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("Unknown command"));
    }

    #[test]
    fn dispatch_register_then_query() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        // Register a patient via command dispatch
        let cmd = RpcCommandPayload {
            command: "register_patient".to_string(),
            data: serde_json::json!({
                "patient": {
                    "id": "dispatch_p1",
                    "given_name": "Alice",
                    "surname": "Smith",
                    "date_of_birth": "1985-06-15",
                    "citizenship": "US",
                    "hometown": "Springfield",
                    "phone": "+1555000111",
                    "sex": "F",
                    "camp": null,
                    "additional_data": "{}",
                    "metadata": "{}",
                    "photo_url": null,
                    "government_id": "GOV-D1",
                    "external_patient_id": "EXT-D1",
                    "primary_clinic_id": null,
                    "created_at": 1000,
                    "updated_at": 2000
                },
                "additional_attributes": []
            }),
            token: Some(token.clone()),
        };
        let cmd_result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert_eq!(cmd_result["patient_id"], "dispatch_p1");

        // Query patients via query dispatch
        let qry = RpcQueryPayload {
            query: "get_patients".to_string(),
            params: serde_json::json!({ "limit": 10, "offset": 0 }),
            token: Some(token),
        };
        let qry_result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert_eq!(qry_result["total"], 1);
        assert_eq!(qry_result["data"][0]["given_name"], "Alice");
    }

    #[test]
    fn dispatch_create_event_then_query() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        // Insert prerequisite patient and visit via direct SQL
        conn.execute(
            "INSERT INTO patients (
                id, given_name, surname, date_of_birth, citizenship, hometown,
                phone, sex, additional_data, metadata, is_deleted,
                government_id, external_patient_id,
                created_at, updated_at,
                local_server_created_at, local_server_last_modified_at
            ) VALUES ('dp1', 'Test', 'Patient', '1990-01-01', 'X', 'Town',
                      '555', 'M', '{}', '{}', 0,
                      'GOV', 'EXT',
                      1000, 2000, 1000, 2000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO visits (
                id, patient_id, clinic_id, provider_id, provider_name,
                check_in_timestamp, metadata, is_deleted,
                created_at, updated_at,
                local_server_created_at, local_server_last_modified_at
            ) VALUES ('dv1', 'dp1', 'c1', 'pr1', 'Dr Test',
                      1000, '{}', 0,
                      1000, 2000, 1000, 2000)",
            [],
        )
        .unwrap();

        // Create event via command dispatch
        let cmd = RpcCommandPayload {
            command: "create_event".to_string(),
            data: serde_json::json!({
                "id": "de1",
                "patient_id": "dp1",
                "form_id": "f1",
                "visit_id": "dv1",
                "event_type": "vitals",
                "form_data": "{\"temp\": 37}",
                "metadata": "{}",
                "created_at": 1000,
                "updated_at": 2000,
                "recorded_by_user_id": "u1"
            }),
            token: Some(token.clone()),
        };
        let cmd_result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert_eq!(cmd_result["event_id"], "de1");

        // Query visit events via dispatch
        let qry = RpcQueryPayload {
            query: "get_visit_events".to_string(),
            params: serde_json::json!({ "patient_id": "dp1", "visit_id": "dv1" }),
            token: Some(token),
        };
        let qry_result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        let events = qry_result["data"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["id"], "de1");
    }

    // ========================================================================
    // Sync dispatch tests
    // ========================================================================

    // ========================================================================
    // New route dispatch smoke tests
    // ========================================================================

    /// Helper: inserts prerequisite patient and visit rows for command tests.
    fn insert_test_patient_and_visit(conn: &Connection) {
        conn.execute(
            "INSERT INTO patients (
                id, given_name, surname, date_of_birth, citizenship, hometown,
                phone, sex, additional_data, metadata, is_deleted,
                government_id, external_patient_id,
                created_at, updated_at,
                local_server_created_at, local_server_last_modified_at
            ) VALUES ('tp1', 'Test', 'Patient', '1990-01-01', 'X', 'Town',
                      '555', 'M', '{}', '{}', 0,
                      'GOV', 'EXT',
                      1000, 2000, 1000, 2000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO visits (
                id, patient_id, clinic_id, provider_id, provider_name,
                check_in_timestamp, metadata, is_deleted,
                created_at, updated_at,
                local_server_created_at, local_server_last_modified_at
            ) VALUES ('tv1', 'tp1', 'c1', 'pr1', 'Dr Test',
                      1000, '{}', 0,
                      1000, 2000, 1000, 2000)",
            [],
        )
        .unwrap();
    }

    // -- Query route smoke tests --

    #[test]
    fn dispatch_clinics_list() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let qry = RpcQueryPayload {
            query: "clinics.list".to_string(),
            params: serde_json::json!({}),
            token: Some(token),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
        assert!(result["data"].is_array());
    }

    #[test]
    fn dispatch_clinic_departments_list() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let qry = RpcQueryPayload {
            query: "clinic_departments.list".to_string(),
            params: serde_json::json!({ "clinic_id": "c1" }),
            token: Some(token),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
        assert!(result["data"].is_array());
    }

    #[test]
    fn dispatch_event_forms_list() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let qry = RpcQueryPayload {
            query: "event_forms.list".to_string(),
            params: serde_json::json!({ "language": "en" }),
            token: Some(token),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
        assert!(result["data"].is_array());
    }

    #[test]
    fn dispatch_registration_form_get() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let qry = RpcQueryPayload {
            query: "registration_form.get".to_string(),
            params: serde_json::json!({}),
            token: Some(token),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        // No registration form in test DB, so it returns an error msg — but not an auth error
        assert!(
            result.get("error").is_none()
                || result["error"]
                    .as_str()
                    .unwrap()
                    .contains("No registration form")
        );
    }

    #[test]
    fn dispatch_patients_similar() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let qry = RpcQueryPayload {
            query: "patients.similar".to_string(),
            params: serde_json::json!({ "given_name": "Alice", "surname": "Smith" }),
            token: Some(token),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
        assert!(result["data"].is_array());
    }

    #[test]
    fn dispatch_drugs_search() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let qry = RpcQueryPayload {
            query: "drugs.search".to_string(),
            params: serde_json::json!({}),
            token: Some(token),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
        assert!(result["data"].is_array());
    }

    #[test]
    fn dispatch_inventory_check_availability() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let qry = RpcQueryPayload {
            query: "inventory.check_availability".to_string(),
            params: serde_json::json!({
                "drug_id": "d1", "clinic_id": "c1", "required_quantity": 10
            }),
            token: Some(token),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
        assert!(result.get("available").is_some());
    }

    // -- Command route smoke tests --

    #[test]
    fn dispatch_visits_update() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        insert_test_patient_and_visit(&conn);
        let token = make_test_token("u1", "c1");

        let cmd = RpcCommandPayload {
            command: "visits.update".to_string(),
            data: serde_json::json!({
                "id": "tv1",
                "provider_name": "Dr Updated"
            }),
            token: Some(token),
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
        assert_eq!(result["provider_name"], "Dr Updated");
    }

    #[test]
    fn dispatch_appointments_create_and_cancel() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        insert_test_patient_and_visit(&conn);
        let token = make_test_token("u1", "c1");

        // Create
        let cmd = RpcCommandPayload {
            command: "appointments.create".to_string(),
            data: serde_json::json!({
                "id": "appt1",
                "clinic_id": "c1",
                "patient_id": "tp1",
                "user_id": "u1",
                "current_visit_id": "tv1",
                "timestamp": 1000,
                "reason": "Checkup",
                "notes": "",
                "departments": "[]",
                "status": "pending",
                "metadata": "{}",
                "created_at": 1000,
                "updated_at": 1000
            }),
            token: Some(token.clone()),
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
        assert_eq!(result["appointment_id"], "appt1");

        // Cancel
        let cmd = RpcCommandPayload {
            command: "appointments.cancel".to_string(),
            data: serde_json::json!({ "id": "appt1" }),
            token: Some(token.clone()),
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());

        // Verify via query
        let qry = RpcQueryPayload {
            query: "appointments.get".to_string(),
            params: serde_json::json!({ "id": "appt1" }),
            token: Some(token),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert_eq!(result["status"], "cancelled");
    }

    #[test]
    fn dispatch_prescriptions_create_and_pickup() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let cmd = RpcCommandPayload {
            command: "prescriptions.create".to_string(),
            data: serde_json::json!({
                "patient_id": "p1",
                "provider_id": "u1",
                "pickup_clinic_id": "c1",
                "prescribed_at": 1000,
                "status": "pending",
                "items": "[]",
                "notes": "",
                "metadata": "{}",
                "created_at": 1000,
                "updated_at": 1000
            }),
            token: Some(token.clone()),
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
        let rx_id = result["prescription_id"].as_str().unwrap().to_string();

        // Pickup
        let cmd = RpcCommandPayload {
            command: "prescriptions.pickup".to_string(),
            data: serde_json::json!({ "id": rx_id, "provider_id": "pharm1" }),
            token: Some(token),
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
    }

    #[test]
    fn dispatch_dispensing_create() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let cmd = RpcCommandPayload {
            command: "dispensing.create".to_string(),
            data: serde_json::json!({
                "clinic_id": "c1",
                "drug_id": "d1",
                "patient_id": "p1",
                "quantity_dispensed": 10,
                "dispensed_by": "u1",
                "dispensed_at": 1000
            }),
            token: Some(token),
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
        assert!(result.get("id").is_some());
    }

    #[test]
    fn dispatch_new_queries_require_auth() {
        let conn = setup_test_db();
        let routes = [
            "clinics.list",
            "clinic_departments.list",
            "event_forms.list",
            "registration_form.get",
            "patients.similar",
            "appointments.list",
            "appointments.get",
            "appointments.by_patient",
            "appointments.search",
            "prescriptions.search",
            "prescriptions.by_patient_visit",
            "prescription_items.by_prescription",
            "prescription_items.by_patient",
            "drugs.search",
            "drugs.get",
            "drugs.by_barcode",
            "inventory.by_clinic",
            "inventory.search",
            "inventory.check_availability",
            "dispensing.by_patient",
            "vitals.list",
        ];
        for route in routes {
            let qry = RpcQueryPayload {
                query: route.to_string(),
                params: serde_json::json!({}),
                token: None,
            };
            let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
            assert!(
                result["error"]
                    .as_str()
                    .unwrap_or("")
                    .contains("Authentication required"),
                "query '{}' should require auth but didn't",
                route
            );
        }
    }

    #[test]
    fn dispatch_new_commands_require_auth() {
        let conn = setup_test_db();
        let routes = [
            "visits.update",
            "vitals.create",
            "vitals.update",
            "appointments.create",
            "appointments.update",
            "appointments.cancel",
            "appointments.complete",
            "prescriptions.create",
            "prescriptions.update",
            "prescriptions.update_status",
            "prescriptions.pickup",
            "prescription_items.create",
            "prescription_items.update",
            "prescription_items.dispense",
            "dispensing.create",
        ];
        for route in routes {
            let cmd = RpcCommandPayload {
                command: route.to_string(),
                data: serde_json::json!({}),
                token: None,
            };
            let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
            assert!(
                result["error"]
                    .as_str()
                    .unwrap_or("")
                    .contains("Authentication required"),
                "command '{}' should require auth but didn't",
                route
            );
        }
    }

    // ========================================================================
    // Sync dispatch tests
    // ========================================================================

    #[test]
    fn dispatch_sync_pull_requires_auth() {
        let conn = setup_test_db();
        let qry = RpcQueryPayload {
            query: "sync_pull".to_string(),
            params: serde_json::json!({ "last_pulled_at": 0 }),
            token: None,
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("Authentication required"));
    }

    #[test]
    fn dispatch_sync_push_requires_auth() {
        let conn = setup_test_db();
        let cmd = RpcCommandPayload {
            command: "sync_push".to_string(),
            data: serde_json::json!({
                "last_pulled_at": 0,
                "changes": {}
            }),
            token: None,
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("Authentication required"));
    }

    #[test]
    fn dispatch_sync_pull_with_auth() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let qry = RpcQueryPayload {
            query: "sync_pull".to_string(),
            params: serde_json::json!({ "last_pulled_at": 0 }),
            token: Some(token),
        };
        let result = dispatch_query(&qry, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("timestamp").is_some());
        assert!(result.get("error").is_none());
    }

    #[test]
    fn dispatch_sync_push_with_auth() {
        let conn = setup_test_db();
        insert_test_user_and_permissions(&conn, "u1", "c1");
        let token = make_test_token("u1", "c1");

        let cmd = RpcCommandPayload {
            command: "sync_push".to_string(),
            data: serde_json::json!({
                "last_pulled_at": 0,
                "changes": {}
            }),
            token: Some(token),
        };
        let result = dispatch_command(&cmd, &conn, Some(TEST_JWT_KEY));
        assert!(result.get("error").is_none());
    }
}
