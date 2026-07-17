import type Database from "better-sqlite3";

/**
 * Add resumable integration setup state and OAuth refresh coordination without
 * rewriting legacy credentials.
 *
 * The migration is deliberately schema-only: credentials are referenced by ID,
 * and their type/encrypted_data columns are never selected, decrypted, or updated.
 */
export function migrateIntegrationSetupV36(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const currentVersion = db.pragma("user_version", { simple: true }) as number;
    if (currentVersion >= 36) return;
    db.exec(`
      CREATE TABLE integration_setup_flows (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
        integration_id TEXT NOT NULL CHECK(length(integration_id) BETWEEN 1 AND 128),
        manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 128),
        manifest_version TEXT NOT NULL CHECK(length(manifest_version) BETWEEN 1 AND 64),
        manifest_credential_id TEXT CHECK(
          manifest_credential_id IS NULL OR length(manifest_credential_id) BETWEEN 1 AND 128
        ),
        credential_type TEXT NOT NULL CHECK(length(credential_type) BETWEEN 1 AND 128),
        mode TEXT NOT NULL CHECK(mode IN ('setup', 'reconfigure', 'reauthenticate')),
        status TEXT NOT NULL CHECK(status IN (
          'awaiting-input', 'awaiting-oauth', 'awaiting-confirmation', 'discovering',
          'completed', 'failed', 'cancelled', 'expired'
        )),
        auth_status TEXT NOT NULL CHECK(auth_status IN (
          'unknown', 'active', 'expired', 'revoked', 'reauthentication-required', 'failed'
        )),
        current_step INTEGER NOT NULL DEFAULT 0 CHECK(current_step BETWEEN 0 AND 256),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 2147483647),
        start_request_sha256 TEXT CHECK(
          start_request_sha256 IS NULL OR (
            length(start_request_sha256) = 64 AND
            start_request_sha256 NOT GLOB '*[^0-9a-f]*'
          )
        ),
        failure_code TEXT CHECK(
          failure_code IS NULL OR (
            length(failure_code) BETWEEN 1 AND 128 AND
            substr(failure_code, 1, 1) GLOB '[a-z]' AND
            substr(failure_code, -1, 1) GLOB '[a-z0-9]' AND
            failure_code NOT GLOB '*[^a-z0-9._-]*' AND
            failure_code NOT GLOB '*[._-][._-]*'
          )
        ),
        duplicate_candidate_ids TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(duplicate_candidate_ids))
          CHECK(json_type(duplicate_candidate_ids) = 'array')
          CHECK(length(CAST(duplicate_candidate_ids AS BLOB)) BETWEEN 2 AND 65536),
        target_credential_id TEXT CHECK(
          target_credential_id IS NULL OR length(target_credential_id) BETWEEN 1 AND 256
        ),
        target_credential_encrypted_data_sha256 TEXT CHECK(
          target_credential_encrypted_data_sha256 IS NULL OR (
            length(target_credential_encrypted_data_sha256) = 64 AND
            target_credential_encrypted_data_sha256 NOT GLOB '*[^0-9a-f]*'
          )
        ),
        credential_create_additional INTEGER NOT NULL DEFAULT 0 CHECK(
          typeof(credential_create_additional) = 'integer' AND
          credential_create_additional IN (0, 1)
        ),
        oauth_credential_id TEXT CHECK(
          oauth_credential_id IS NULL OR length(oauth_credential_id) BETWEEN 1 AND 256
        ),
        oauth_create_additional INTEGER NOT NULL DEFAULT 0 CHECK(
          typeof(oauth_create_additional) = 'integer' AND oauth_create_additional IN (0, 1)
        ),
        created_at TEXT NOT NULL CHECK(
          length(created_at) BETWEEN 20 AND 32 AND julianday(created_at) IS NOT NULL
        ),
        updated_at TEXT NOT NULL CHECK(
          length(updated_at) BETWEEN 20 AND 32 AND julianday(updated_at) IS NOT NULL
        ),
        expires_at TEXT NOT NULL CHECK(
          length(expires_at) BETWEEN 20 AND 32 AND julianday(expires_at) IS NOT NULL
        ),
        completed_at TEXT CHECK(
          completed_at IS NULL OR (
            length(completed_at) BETWEEN 20 AND 32 AND julianday(completed_at) IS NOT NULL
          )
        ),
        CHECK(julianday(updated_at) >= julianday(created_at)),
        CHECK(julianday(expires_at) > julianday(created_at)),
        CHECK(completed_at IS NULL OR julianday(completed_at) >= julianday(created_at)),
        CHECK(target_credential_encrypted_data_sha256 IS NULL OR target_credential_id IS NOT NULL),
        CHECK(credential_create_additional = 0 OR target_credential_id IS NULL),
        CHECK(oauth_create_additional = 0 OR oauth_credential_id IS NULL),
        CHECK(
          (status IN ('completed', 'failed', 'cancelled', 'expired') AND completed_at IS NOT NULL) OR
          (status NOT IN ('completed', 'failed', 'cancelled', 'expired') AND completed_at IS NULL)
        )
      );

      CREATE TABLE integration_setup_steps (
        flow_id TEXT NOT NULL CHECK(length(flow_id) BETWEEN 1 AND 256),
        position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 255),
        step_id TEXT NOT NULL CHECK(length(step_id) BETWEEN 1 AND 128),
        kind TEXT NOT NULL CHECK(kind IN ('instruction', 'credential', 'oauth', 'diagnostic')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1000000),
        failure_code TEXT CHECK(
          failure_code IS NULL OR (
            length(failure_code) BETWEEN 1 AND 128 AND
            substr(failure_code, 1, 1) GLOB '[a-z]' AND
            substr(failure_code, -1, 1) GLOB '[a-z0-9]' AND
            failure_code NOT GLOB '*[^a-z0-9._-]*' AND
            failure_code NOT GLOB '*[._-][._-]*'
          )
        ),
        started_at TEXT CHECK(
          started_at IS NULL OR (
            length(started_at) BETWEEN 20 AND 32 AND julianday(started_at) IS NOT NULL
          )
        ),
        completed_at TEXT CHECK(
          completed_at IS NULL OR (
            length(completed_at) BETWEEN 20 AND 32 AND julianday(completed_at) IS NOT NULL
          )
        ),
        created_at TEXT NOT NULL CHECK(
          length(created_at) BETWEEN 20 AND 32 AND julianday(created_at) IS NOT NULL
        ),
        updated_at TEXT NOT NULL CHECK(
          length(updated_at) BETWEEN 20 AND 32 AND julianday(updated_at) IS NOT NULL
        ),
        PRIMARY KEY(flow_id, position),
        UNIQUE(flow_id, step_id),
        FOREIGN KEY(flow_id) REFERENCES integration_setup_flows(id) ON DELETE CASCADE,
        CHECK(julianday(updated_at) >= julianday(created_at)),
        CHECK(started_at IS NULL OR julianday(started_at) >= julianday(created_at)),
        CHECK(completed_at IS NULL OR julianday(completed_at) >= julianday(created_at)),
        CHECK(
          (status = 'pending' AND started_at IS NULL AND completed_at IS NULL AND failure_code IS NULL) OR
          (status = 'active' AND started_at IS NOT NULL AND completed_at IS NULL AND failure_code IS NULL) OR
          (status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND
            failure_code IS NULL) OR
          (status = 'failed' AND started_at IS NOT NULL AND completed_at IS NOT NULL)
        )
      );

      CREATE TABLE integration_setup_secret_envelopes (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
        flow_id TEXT NOT NULL CHECK(length(flow_id) BETWEEN 1 AND 256),
        purpose TEXT NOT NULL CHECK(purpose IN ('pkce', 'staged-oauth', 'staged-credential')),
        encrypted_payload TEXT NOT NULL CHECK(
          length(encrypted_payload) BETWEEN 56 AND 2097208 AND
          length(encrypted_payload) % 2 = 0 AND
          encrypted_payload NOT GLOB '*[^0-9a-f]*'
        ),
        state_sha256 TEXT CHECK(
          state_sha256 IS NULL OR (
            length(state_sha256) = 64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'
          )
        ),
        created_at TEXT NOT NULL CHECK(
          length(created_at) BETWEEN 20 AND 32 AND julianday(created_at) IS NOT NULL
        ),
        expires_at TEXT NOT NULL CHECK(
          length(expires_at) BETWEEN 20 AND 32 AND julianday(expires_at) IS NOT NULL
        ),
        UNIQUE(flow_id, purpose),
        FOREIGN KEY(flow_id) REFERENCES integration_setup_flows(id) ON DELETE CASCADE,
        CHECK(julianday(expires_at) > julianday(created_at))
      );

      CREATE TABLE integration_credential_bindings (
        credential_id TEXT NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 256),
        integration_id TEXT NOT NULL CHECK(length(integration_id) BETWEEN 1 AND 128),
        manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 128),
        manifest_version TEXT NOT NULL CHECK(length(manifest_version) BETWEEN 1 AND 64),
        manifest_credential_id TEXT NOT NULL CHECK(length(manifest_credential_id) BETWEEN 1 AND 128),
        auth_method TEXT NOT NULL CHECK(auth_method IN (
          'credential', 'api-key', 'basic', 'bearer', 'oauth', 'oauth2',
          'service-account', 'custom'
        )),
        auth_status TEXT NOT NULL CHECK(auth_status IN (
          'unknown', 'active', 'expired', 'revoked', 'reauthentication-required', 'failed'
        )),
        failure_code TEXT CHECK(
          failure_code IS NULL OR (
            length(failure_code) BETWEEN 1 AND 128 AND
            substr(failure_code, 1, 1) GLOB '[a-z]' AND
            substr(failure_code, -1, 1) GLOB '[a-z0-9]' AND
            failure_code NOT GLOB '*[^a-z0-9._-]*' AND
            failure_code NOT GLOB '*[._-][._-]*'
          )
        ),
        token_expires_at TEXT CHECK(
          token_expires_at IS NULL OR (
            length(token_expires_at) BETWEEN 20 AND 32 AND
            julianday(token_expires_at) IS NOT NULL
          )
        ),
        scopes TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(scopes))
          CHECK(json_type(scopes) = 'array')
          CHECK(length(CAST(scopes AS BLOB)) BETWEEN 2 AND 65536),
        account_fingerprint TEXT CHECK(
          account_fingerprint IS NULL OR (
            length(account_fingerprint) = 64 AND
            account_fingerprint NOT GLOB '*[^0-9a-f]*'
          )
        ),
        account_label TEXT CHECK(
          account_label IS NULL OR length(account_label) BETWEEN 1 AND 320
        ),
        created_at TEXT NOT NULL CHECK(
          length(created_at) BETWEEN 20 AND 32 AND julianday(created_at) IS NOT NULL
        ),
        updated_at TEXT NOT NULL CHECK(
          length(updated_at) BETWEEN 20 AND 32 AND julianday(updated_at) IS NOT NULL
        ),
        auth_checked_at TEXT CHECK(
          auth_checked_at IS NULL OR (
            length(auth_checked_at) BETWEEN 20 AND 32 AND julianday(auth_checked_at) IS NOT NULL
          )
        ),
        PRIMARY KEY(credential_id, integration_id, manifest_credential_id),
        FOREIGN KEY(credential_id) REFERENCES credentials(id) ON DELETE CASCADE,
        CHECK(julianday(updated_at) >= julianday(created_at)),
        CHECK(auth_checked_at IS NULL OR julianday(auth_checked_at) >= julianday(created_at)),
        CHECK(auth_status != 'active' OR failure_code IS NULL)
      );

      CREATE TABLE oauth_refresh_leases (
        credential_id TEXT PRIMARY KEY CHECK(length(credential_id) BETWEEN 1 AND 256),
        lease_id TEXT NOT NULL UNIQUE CHECK(
          length(lease_id) = 32 AND lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        acquired_at TEXT NOT NULL CHECK(
          length(acquired_at) BETWEEN 20 AND 32 AND julianday(acquired_at) IS NOT NULL
        ),
        expires_at TEXT NOT NULL CHECK(
          length(expires_at) BETWEEN 20 AND 32 AND julianday(expires_at) IS NOT NULL
        ),
        FOREIGN KEY(credential_id) REFERENCES credentials(id) ON DELETE CASCADE,
        CHECK(julianday(expires_at) > julianday(acquired_at))
      );

      CREATE INDEX idx_integration_setup_flows_identity
        ON integration_setup_flows(integration_id, manifest_id, status, updated_at DESC, id DESC);
      CREATE INDEX idx_integration_setup_flows_status_expiry
        ON integration_setup_flows(status, expires_at);
      CREATE INDEX idx_integration_setup_steps_flow
        ON integration_setup_steps(flow_id, position);
      CREATE UNIQUE INDEX idx_integration_setup_envelopes_state
        ON integration_setup_secret_envelopes(state_sha256)
        WHERE state_sha256 IS NOT NULL;
      CREATE INDEX idx_integration_setup_envelopes_expiry
        ON integration_setup_secret_envelopes(expires_at);
      CREATE INDEX idx_integration_credential_bindings_manifest
        ON integration_credential_bindings(
          integration_id, manifest_id, manifest_credential_id, auth_status, updated_at DESC
        );
      CREATE INDEX idx_integration_credential_bindings_auth
        ON integration_credential_bindings(auth_status, token_expires_at);
      CREATE INDEX idx_oauth_refresh_leases_expiry
        ON oauth_refresh_leases(expires_at);

      CREATE TRIGGER integration_setup_flows_validate_candidates_insert
      BEFORE INSERT ON integration_setup_flows
      BEGIN
        SELECT CASE WHEN json_array_length(NEW.duplicate_candidate_ids) > 256 OR EXISTS (
          SELECT 1 FROM json_each(NEW.duplicate_candidate_ids)
          WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 128 OR
            substr(value, 1, 1) NOT GLOB '[A-Za-z0-9]' OR
            value GLOB '*[^A-Za-z0-9._:-]*'
        ) THEN RAISE(ABORT, 'integration setup candidates must be bounded credential IDs') END;
        SELECT CASE WHEN (
          SELECT count(*) FROM json_each(NEW.duplicate_candidate_ids)
        ) != (
          SELECT count(DISTINCT value) FROM json_each(NEW.duplicate_candidate_ids)
        ) THEN RAISE(ABORT, 'integration setup candidate credential IDs must be unique') END;
      END;

      CREATE TRIGGER integration_setup_flows_validate_update
      BEFORE UPDATE ON integration_setup_flows
      BEGIN
        SELECT CASE WHEN
          NEW.id != OLD.id OR NEW.integration_id != OLD.integration_id OR
          NEW.manifest_id != OLD.manifest_id OR NEW.manifest_version != OLD.manifest_version OR
          NEW.manifest_credential_id IS NOT OLD.manifest_credential_id OR
          NEW.credential_type != OLD.credential_type OR NEW.mode != OLD.mode OR
          NEW.start_request_sha256 IS NOT OLD.start_request_sha256 OR
          NEW.created_at != OLD.created_at OR NEW.expires_at != OLD.expires_at
        THEN RAISE(ABORT, 'integration setup flow identity fields are immutable') END;
        SELECT CASE WHEN NEW.revision != OLD.revision + 1
        THEN RAISE(ABORT, 'integration setup flow revision must advance by one') END;
        SELECT CASE WHEN NEW.current_step < OLD.current_step OR NEW.current_step > OLD.current_step + 1
        THEN RAISE(ABORT, 'integration setup current step must advance monotonically') END;
        SELECT CASE WHEN julianday(NEW.updated_at) < julianday(OLD.updated_at)
        THEN RAISE(ABORT, 'integration setup updated timestamp cannot move backwards') END;
        SELECT CASE WHEN NOT (
          NEW.status = OLD.status OR
          (OLD.status = 'awaiting-input' AND NEW.status IN (
            'awaiting-oauth', 'awaiting-confirmation', 'discovering',
            'completed', 'failed', 'cancelled', 'expired'
          )) OR
          (OLD.status = 'awaiting-oauth' AND NEW.status IN (
            'awaiting-input', 'awaiting-confirmation', 'discovering',
            'completed', 'failed', 'cancelled', 'expired'
          )) OR
          (OLD.status = 'awaiting-confirmation' AND NEW.status IN (
            'awaiting-input', 'awaiting-oauth', 'discovering',
            'completed', 'failed', 'cancelled', 'expired'
          )) OR
          (OLD.status = 'discovering' AND NEW.status IN (
            'awaiting-input', 'awaiting-oauth', 'awaiting-confirmation',
            'completed', 'failed', 'cancelled', 'expired'
          ))
        ) THEN RAISE(ABORT, 'illegal integration setup flow transition') END;
        SELECT CASE WHEN OLD.status IN ('completed', 'failed', 'cancelled', 'expired')
        THEN RAISE(ABORT, 'terminal integration setup flow is immutable') END;
        SELECT CASE WHEN json_array_length(NEW.duplicate_candidate_ids) > 256 OR EXISTS (
          SELECT 1 FROM json_each(NEW.duplicate_candidate_ids)
          WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 128 OR
            substr(value, 1, 1) NOT GLOB '[A-Za-z0-9]' OR
            value GLOB '*[^A-Za-z0-9._:-]*'
        ) THEN RAISE(ABORT, 'integration setup candidates must be bounded credential IDs') END;
        SELECT CASE WHEN (
          SELECT count(*) FROM json_each(NEW.duplicate_candidate_ids)
        ) != (
          SELECT count(DISTINCT value) FROM json_each(NEW.duplicate_candidate_ids)
        ) THEN RAISE(ABORT, 'integration setup candidate credential IDs must be unique') END;
      END;

      CREATE TRIGGER integration_setup_steps_validate_update
      BEFORE UPDATE ON integration_setup_steps
      BEGIN
        SELECT CASE WHEN
          NEW.flow_id != OLD.flow_id OR NEW.position != OLD.position OR
          NEW.step_id != OLD.step_id OR NEW.kind != OLD.kind OR NEW.created_at != OLD.created_at
        THEN RAISE(ABORT, 'integration setup step identity fields are immutable') END;
        SELECT CASE WHEN julianday(NEW.updated_at) < julianday(OLD.updated_at)
        THEN RAISE(ABORT, 'integration setup step timestamp cannot move backwards') END;
        SELECT CASE WHEN NOT (
          NEW.status = OLD.status OR
          (OLD.status = 'pending' AND NEW.status IN ('active', 'failed')) OR
          (OLD.status = 'active' AND NEW.status IN ('completed', 'failed')) OR
          (OLD.status = 'failed' AND NEW.status = 'active')
        ) THEN RAISE(ABORT, 'illegal integration setup step transition') END;
        SELECT CASE WHEN OLD.status = 'completed'
        THEN RAISE(ABORT, 'terminal integration setup step is immutable') END;
      END;

      CREATE TRIGGER integration_setup_steps_one_active_insert
      BEFORE INSERT ON integration_setup_steps
      WHEN NEW.status = 'active'
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM integration_setup_steps
          WHERE flow_id = NEW.flow_id AND status = 'active'
        ) THEN RAISE(ABORT, 'integration setup flow can have only one active step') END;
      END;

      CREATE TRIGGER integration_setup_steps_one_active_update
      BEFORE UPDATE OF status ON integration_setup_steps
      WHEN NEW.status = 'active' AND OLD.status != 'active'
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM integration_setup_steps
          WHERE flow_id = NEW.flow_id AND status = 'active' AND position != NEW.position
        ) THEN RAISE(ABORT, 'integration setup flow can have only one active step') END;
      END;

      CREATE TRIGGER integration_setup_envelopes_validate_purpose_insert
      BEFORE INSERT ON integration_setup_secret_envelopes
      BEGIN
        SELECT CASE WHEN NEW.state_sha256 IS NOT NULL AND NEW.purpose = 'staged-credential'
        THEN RAISE(ABORT, 'staged credential envelope cannot carry OAuth state') END;
      END;

      CREATE TRIGGER integration_setup_bindings_validate_scopes_insert
      BEFORE INSERT ON integration_credential_bindings
      BEGIN
        SELECT CASE WHEN json_array_length(NEW.scopes) > 128 OR EXISTS (
          SELECT 1 FROM json_each(NEW.scopes)
          WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 1024
        ) THEN RAISE(ABORT, 'integration credential scopes must be bounded strings') END;
        SELECT CASE WHEN (
          SELECT count(*) FROM json_each(NEW.scopes)
        ) != (
          SELECT count(DISTINCT value) FROM json_each(NEW.scopes)
        ) THEN RAISE(ABORT, 'integration credential scopes must be unique') END;
      END;

      CREATE TRIGGER integration_setup_bindings_validate_update
      BEFORE UPDATE ON integration_credential_bindings
      BEGIN
        SELECT CASE WHEN
          NEW.credential_id != OLD.credential_id OR NEW.integration_id != OLD.integration_id OR
          NEW.manifest_credential_id != OLD.manifest_credential_id OR NEW.created_at != OLD.created_at
        THEN RAISE(ABORT, 'integration credential binding identity fields are immutable') END;
        SELECT CASE WHEN julianday(NEW.updated_at) < julianday(OLD.updated_at)
        THEN RAISE(ABORT, 'integration credential binding timestamp cannot move backwards') END;
        SELECT CASE WHEN json_array_length(NEW.scopes) > 128 OR EXISTS (
          SELECT 1 FROM json_each(NEW.scopes)
          WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 1024
        ) THEN RAISE(ABORT, 'integration credential scopes must be bounded strings') END;
        SELECT CASE WHEN (
          SELECT count(*) FROM json_each(NEW.scopes)
        ) != (
          SELECT count(DISTINCT value) FROM json_each(NEW.scopes)
        ) THEN RAISE(ABORT, 'integration credential scopes must be unique') END;
      END;
    `);
    db.pragma("user_version = 36");
  });

  migrate.immediate();
}
