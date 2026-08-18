import type { StateDb } from '../state/state-db.ts';

interface WorkMigration {
  version: number;
  statements: readonly string[];
  after?: (db: StateDb) => void;
}

const CREATE_LEDGER_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS works (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('conversation', 'routine', 'web_admin')),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open', 'closed', 'expired')),
    maximum_sensitivity TEXT NOT NULL CHECK (maximum_sensitivity IN ('public', 'private')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    CHECK ((lifecycle = 'open' AND closed_at IS NULL) OR
           (lifecycle <> 'open' AND closed_at IS NOT NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS effective_config_revisions (
    id TEXT PRIMARY KEY,
    canonical_json TEXT NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ledger_content (
    ref TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'private')),
    expires_at INTEGER NOT NULL,
    body TEXT,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= 262144),
    created_at INTEGER NOT NULL,
    purged_at INTEGER,
    CHECK ((purged_at IS NULL AND body IS NOT NULL AND byte_size > 0) OR
           (purged_at IS NOT NULL AND body IS NULL AND byte_size = 0))
  )`,
  `CREATE TABLE IF NOT EXISTS bindings (
    id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL,
    adapter_kind TEXT NOT NULL CHECK (adapter_kind IN ('slack', 'routine', 'web_admin', 'conformance')),
    external_account_id TEXT NOT NULL,
    external_conversation_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'closed', 'expired')),
    source_visibility TEXT NOT NULL CHECK (source_visibility IN ('public', 'private', 'unknown')),
    config_mode TEXT NOT NULL CHECK (config_mode IN ('frozen_on_open', 'resolve_each_run')),
    pinned_config_revision_id TEXT,
    ordering_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expired_at INTEGER,
    UNIQUE (id, work_id),
    FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE RESTRICT,
    FOREIGN KEY (pinned_config_revision_id) REFERENCES effective_config_revisions(id) ON DELETE RESTRICT,
    CHECK ((lifecycle = 'active' AND expired_at IS NULL) OR
           (lifecycle <> 'active' AND expired_at IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS bindings_active_identity_unique
   ON bindings (adapter_kind, external_account_id, external_conversation_id)
   WHERE lifecycle = 'active'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS bindings_identity_generation_unique
   ON bindings (adapter_kind, external_account_id, external_conversation_id, generation)`,
  `CREATE INDEX IF NOT EXISTS bindings_work_idx ON bindings (work_id, created_at, id)`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('interactive', 'routine', 'operator')),
    admission_sequence INTEGER NOT NULL CHECK (admission_sequence > 0),
    trigger_kind TEXT NOT NULL,
    trigger_ref TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    actor_ref TEXT,
    actor_trust_tier TEXT NOT NULL CHECK (actor_trust_tier IN ('member', 'operator', 'system', 'unknown')),
    source_context_watermark TEXT,
    trigger_content_ref TEXT,
    prepared_input_ref TEXT,
    config_revision_id TEXT NOT NULL,
    effective_capability_digest TEXT NOT NULL,
    execution_authority TEXT NOT NULL CHECK (execution_authority IN ('legacy', 'ledger')),
    coordinator_kind TEXT NOT NULL CHECK (coordinator_kind IN ('interactive', 'flue_workflow')),
    authority_epoch INTEGER NOT NULL CHECK (authority_epoch > 0),
    policy_approved_output_ref TEXT,
    rendered_payload_ref TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'admitted', 'queued', 'preparing_input', 'input_ready', 'executing',
      'response_ready', 'settled', 'recovery_required'
    )),
    terminal_disposition TEXT CHECK (terminal_disposition IN (
      'succeeded', 'no_op', 'failed', 'skipped', 'cancelled', 'superseded', 'quarantined'
    )),
    delivery_status TEXT NOT NULL CHECK (delivery_status IN (
      'not_ready', 'pending', 'delivered', 'failed', 'unknown', 'not_applicable'
    )),
    delivery_method TEXT,
    delivery_attempt_id TEXT,
    delivery_ref TEXT,
    delivery_finalized_at INTEGER,
    lease_owner TEXT,
    lease_until INTEGER,
    fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
    safe_failure_code TEXT,
    recovery_resolution_kind TEXT CHECK (recovery_resolution_kind IN ('authoritative_reconciliation', 'quarantine')),
    recovery_admin_credential_id TEXT,
    recovery_operator_label TEXT,
    recovery_auth_origin TEXT,
    recovery_reason_code TEXT,
    recovery_request_id TEXT,
    recovery_resolved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settled_at INTEGER,
    UNIQUE (binding_id, admission_sequence),
    UNIQUE (binding_id, dedupe_key),
    UNIQUE (id, work_id),
    FOREIGN KEY (binding_id, work_id) REFERENCES bindings(id, work_id) ON DELETE RESTRICT,
    FOREIGN KEY (trigger_content_ref) REFERENCES ledger_content(ref) ON DELETE RESTRICT,
    FOREIGN KEY (prepared_input_ref) REFERENCES ledger_content(ref) ON DELETE RESTRICT,
    FOREIGN KEY (config_revision_id) REFERENCES effective_config_revisions(id) ON DELETE RESTRICT,
    FOREIGN KEY (policy_approved_output_ref) REFERENCES ledger_content(ref) ON DELETE RESTRICT,
    FOREIGN KEY (rendered_payload_ref) REFERENCES ledger_content(ref) ON DELETE RESTRICT,
    CHECK ((status = 'settled' AND terminal_disposition IS NOT NULL AND settled_at IS NOT NULL) OR
           (status <> 'settled' AND terminal_disposition IS NULL AND settled_at IS NULL)),
    CHECK (status <> 'response_ready' OR
           (policy_approved_output_ref IS NOT NULL AND rendered_payload_ref IS NOT NULL)),
    CHECK (status NOT IN ('input_ready', 'executing', 'response_ready') OR
           prepared_input_ref IS NOT NULL),
    CHECK ((terminal_disposition = 'quarantined' AND recovery_resolution_kind = 'quarantine') OR
           (terminal_disposition IS NOT 'quarantined' AND recovery_resolution_kind IS NOT 'quarantine')),
    CHECK ((recovery_resolution_kind IS NULL AND recovery_admin_credential_id IS NULL AND
            recovery_operator_label IS NULL AND recovery_auth_origin IS NULL AND
            recovery_reason_code IS NULL AND recovery_request_id IS NULL AND recovery_resolved_at IS NULL) OR
           (recovery_resolution_kind = 'authoritative_reconciliation' AND recovery_resolved_at IS NOT NULL AND
            recovery_admin_credential_id IS NULL AND recovery_operator_label IS NULL AND
            recovery_auth_origin IS NULL AND recovery_reason_code IS NOT NULL AND recovery_request_id IS NOT NULL) OR
           (recovery_resolution_kind = 'quarantine' AND recovery_admin_credential_id IS NOT NULL AND
            recovery_operator_label IS NOT NULL AND recovery_auth_origin IS NOT NULL AND
            recovery_reason_code IS NOT NULL AND recovery_request_id IS NOT NULL AND recovery_resolved_at IS NOT NULL)),
    CHECK ((delivery_status IN ('not_ready', 'not_applicable') AND delivery_attempt_id IS NULL AND
            delivery_ref IS NULL AND delivery_finalized_at IS NULL) OR
           (delivery_status IN ('pending', 'failed', 'unknown') AND delivery_attempt_id IS NOT NULL AND delivery_ref IS NULL) OR
           (delivery_status = 'delivered' AND delivery_attempt_id IS NOT NULL AND
            delivery_ref IS NOT NULL AND delivery_finalized_at IS NOT NULL)),
    CHECK ((lease_owner IS NULL AND lease_until IS NULL) OR
           (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS runs_work_created_idx
   ON runs (work_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS runs_binding_sequence_idx
   ON runs (binding_id, admission_sequence, id)`,
  `CREATE INDEX IF NOT EXISTS runs_status_lease_idx
   ON runs (status, lease_until, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS runs_recovery_idx
   ON runs (updated_at DESC, id DESC) WHERE status = 'recovery_required'`,
  `CREATE TABLE IF NOT EXISTS run_executions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    executor_kind TEXT NOT NULL CHECK (executor_kind IN ('agent', 'workflow')),
    agent_name TEXT NOT NULL,
    flue_instance_ref TEXT,
    flue_submission_ref TEXT,
    canonical_model TEXT NOT NULL,
    provider_auth_route TEXT CHECK (provider_auth_route IN ('openai_api_key', 'openai_subscription')),
    catalog_source TEXT,
    catalog_revision TEXT,
    catalog_digest TEXT,
    compiled_profile TEXT,
    model_credential_ref TEXT,
    model_credential_version INTEGER,
    model_invocation_status TEXT NOT NULL CHECK (model_invocation_status IN ('not_invoked', 'ready', 'invoked', 'settled')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    raw_settlement_ref TEXT,
    raw_settlement_status TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'not_submitted', 'succeeded', 'failed', 'ambiguous')),
    safe_disagreement_code TEXT,
    safe_failure_code TEXT,
    UNIQUE (run_id, attempt_number),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
    CHECK ((model_credential_ref IS NULL AND model_credential_version IS NULL) OR
           (model_credential_ref IS NOT NULL AND model_credential_version IS NOT NULL AND model_credential_version > 0)),
    CHECK ((finished_at IS NULL AND outcome = 'pending') OR
           (finished_at IS NOT NULL AND outcome <> 'pending')),
    CHECK (model_invocation_status <> 'not_invoked' OR provider_auth_route IS NULL),
    CHECK (outcome <> 'not_submitted' OR model_invocation_status = 'not_invoked')
  )`,
  `CREATE INDEX IF NOT EXISTS run_executions_run_idx
   ON run_executions (run_id, attempt_number, id)`,
] as const;

const MIGRATIONS: readonly WorkMigration[] = [
  { version: 1, statements: CREATE_LEDGER_STATEMENTS },
  {
    version: 2,
    statements: [],
    after: installCompatibilityLinks,
  },
];

export function installWorkMigrations(db: StateDb): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS app_migrations (
      domain TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (domain, version)
    )`,
  );
  for (const migration of MIGRATIONS) {
    db.transaction(() => {
      const applied = db.get(
        'SELECT 1 AS applied FROM app_migrations WHERE domain = ? AND version = ?',
        'work',
        migration.version,
      );
      if (applied) return;
      for (const statement of migration.statements) db.exec(statement);
      migration.after?.(db);
      db.run(
        'INSERT INTO app_migrations (domain, version, applied_at) VALUES (?, ?, ?)',
        'work',
        migration.version,
        Date.now(),
      );
    });
  }
}

export function installCompatibilityLinks(db: StateDb): void {
  if (tableExists(db, 'routines')) {
    addColumnIfMissing(db, 'routines', 'work_id', 'TEXT');
    addColumnIfMissing(db, 'routines', 'binding_id', 'TEXT');
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS routines_work_link_unique ON routines (work_id) WHERE work_id IS NOT NULL',
    );
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS routines_binding_link_unique ON routines (binding_id) WHERE binding_id IS NOT NULL',
    );
  }
  if (tableExists(db, 'routine_runs')) {
    addColumnIfMissing(db, 'routine_runs', 'canonical_run_id', 'TEXT');
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_canonical_link_unique ON routine_runs (canonical_run_id) WHERE canonical_run_id IS NOT NULL',
    );
  }
  if (tableExists(db, 'usage_operations')) {
    addColumnIfMissing(db, 'usage_operations', 'run_id', 'TEXT');
    db.exec(
      'CREATE INDEX IF NOT EXISTS usage_operations_run_idx ON usage_operations (run_id) WHERE run_id IS NOT NULL',
    );
  }
  if (tableExists(db, 'usage_measurements')) {
    addColumnIfMissing(db, 'usage_measurements', 'run_execution_id', 'TEXT');
    db.exec(
      'CREATE INDEX IF NOT EXISTS usage_measurements_run_execution_idx ON usage_measurements (run_execution_id) WHERE run_execution_id IS NOT NULL',
    );
  }
}

function tableExists(db: StateDb, table: string): boolean {
  return Boolean(
    db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", table),
  );
}

function addColumnIfMissing(
  db: StateDb,
  table: string,
  column: string,
  definition: string,
): void {
  const present = db.all(`PRAGMA table_info(${table})`).some((row) => row.name === column);
  if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
