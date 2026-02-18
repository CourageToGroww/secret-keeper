import { Database } from "bun:sqlite";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import {
  DEFAULT_DB_DIR,
  DEFAULT_DB_NAME,
  LOCAL_DB_DIR,
  SecretMetadata,
  SecretOptions,
  AuditEntry,
  AuditAction,
  VaultNotInitializedError,
  SecretNotFoundError,
  RotationConfig,
  RotationHistoryEntry,
  ProviderConfig,
  ProviderType,
} from "./types";
import { encrypt, decrypt } from "./crypto";

// ============================================================================
// SQL Schema
// ============================================================================

const SCHEMA = {
  vaultConfig: `
    CREATE TABLE IF NOT EXISTS vault_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `,
  secrets: `
    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      encrypted_value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      description TEXT,
      tags TEXT,
      sensitive INTEGER DEFAULT 1
    )
  `,
  auditLog: `
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      secret_name TEXT,
      details TEXT
    )
  `,
  rotationConfig: `
    CREATE TABLE IF NOT EXISTS rotation_config (
      secret_name TEXT PRIMARY KEY REFERENCES secrets(name),
      provider_type TEXT NOT NULL,
      schedule_days INTEGER NOT NULL,
      last_rotated TEXT,
      next_rotation TEXT,
      enabled INTEGER DEFAULT 1,
      provider_config TEXT
    )
  `,
  rotationHistory: `
    CREATE TABLE IF NOT EXISTS rotation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      secret_name TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      error_message TEXT
    )
  `,
};

// ============================================================================
// SecretDatabase Class
// ============================================================================

export class SecretDatabase {
  private db!: Database;
  private dbPath: string;
  private encryptionKey: string | null = null;

  constructor(projectPath?: string, forceLocal: boolean = false) {
    this.dbPath = this.resolveDatabasePath(projectPath, forceLocal);
  }

  /**
   * Resolve the database path based on project context
   */
  private resolveDatabasePath(projectPath?: string, forceLocal: boolean = false): string {
    // If projectPath provided or forceLocal, use local vault
    if (projectPath || forceLocal) {
      const basePath = projectPath || process.cwd();
      return join(basePath, LOCAL_DB_DIR, DEFAULT_DB_NAME);
    }

    // Check for local vault in current directory
    const localPath = join(process.cwd(), LOCAL_DB_DIR, DEFAULT_DB_NAME);
    if (existsSync(localPath)) {
      return localPath;
    }

    // Fall back to global vault
    return join(DEFAULT_DB_DIR, DEFAULT_DB_NAME);
  }

  /**
   * Get the database path
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * Check if vault is project-local
   */
  isLocal(): boolean {
    return this.dbPath.includes(LOCAL_DB_DIR);
  }

  /**
   * Open the database connection
   */
  private open(): void {
    if (!this.db) {
      this.db = new Database(this.dbPath, { create: false, strict: true });
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec("PRAGMA synchronous=FULL");
      this.db.exec("PRAGMA foreign_keys=ON");
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null!;
    }
    this.encryptionKey = null;
  }

  // ============================================================================
  // Vault Lifecycle
  // ============================================================================

  /**
   * Check if the vault is initialized
   */
  isInitialized(): boolean {
    return existsSync(this.dbPath);
  }

  /**
   * Initialize a new vault with the given encryption key
   */
  async initialize(encryptionKey: string): Promise<boolean> {
    // Create directory if needed
    const dbDir = dirname(this.dbPath);
    await mkdir(dbDir, { recursive: true, mode: 0o700 });

    // Create database
    this.db = new Database(this.dbPath, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA foreign_keys=ON");

    // Create tables
    this.db.exec(SCHEMA.vaultConfig);
    this.db.exec(SCHEMA.secrets);
    this.db.exec(SCHEMA.auditLog);
    this.db.exec(SCHEMA.rotationConfig);
    this.db.exec(SCHEMA.rotationHistory);

    // Store metadata (no password hash)
    const now = new Date().toISOString();

    const insert = this.db.prepare(
      "INSERT INTO vault_config (key, value) VALUES (?, ?)"
    );
    insert.run("created_at", now);
    insert.run("version", "2");

    this.encryptionKey = encryptionKey;
    this.logAudit("VAULT_INITIALIZED");

    return true;
  }

  /**
   * Load the encryption key for vault operations
   */
  loadKey(encryptionKey: string): void {
    if (!this.isInitialized()) {
      throw new VaultNotInitializedError();
    }

    this.open();
    this.encryptionKey = encryptionKey;
    this.logAudit("VAULT_UNLOCKED");
  }

  /**
   * Check if the vault has a key loaded
   */
  isUnlocked(): boolean {
    return this.encryptionKey !== null;
  }

  /**
   * Ensure vault has a key loaded before operations
   */
  private ensureUnlocked(): void {
    if (!this.encryptionKey) {
      throw new VaultNotInitializedError();
    }
  }

  // ============================================================================
  // Secret Operations
  // ============================================================================

  /**
   * Add or update a secret
   */
  async addSecret(
    name: string,
    value: string,
    options: SecretOptions = {}
  ): Promise<boolean> {
    this.ensureUnlocked();
    this.migrateSensitiveColumn();

    const encryptedValue = await encrypt(value, this.encryptionKey!);
    const now = new Date().toISOString();
    const tags = options.tags ? JSON.stringify(options.tags) : null;
    const sensitive = options.sensitive !== false ? 1 : 0;  // default to sensitive

    const stmt = this.db.prepare(`
      INSERT INTO secrets (name, encrypted_value, created_at, updated_at, description, tags, sensitive)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        encrypted_value = excluded.encrypted_value,
        updated_at = excluded.updated_at,
        description = COALESCE(excluded.description, description),
        tags = COALESCE(excluded.tags, tags),
        sensitive = excluded.sensitive
    `);

    stmt.run(name, encryptedValue, now, now, options.description || null, tags, sensitive);
    this.logAudit("SECRET_ADDED", name);
    return true;
  }

  /**
   * Get a decrypted secret value
   */
  async getSecret(name: string): Promise<string> {
    this.ensureUnlocked();

    const row = this.db
      .prepare("SELECT encrypted_value FROM secrets WHERE name = ?")
      .get(name) as { encrypted_value: string } | null;

    if (!row) {
      throw new SecretNotFoundError(name);
    }

    return decrypt(row.encrypted_value, this.encryptionKey!);
  }

  /**
   * Get all secrets as a name -> value map
   */
  async getAllSecrets(): Promise<Record<string, string>> {
    this.ensureUnlocked();

    const rows = this.db
      .prepare("SELECT name, encrypted_value FROM secrets")
      .all() as Array<{ name: string; encrypted_value: string }>;

    const secrets: Record<string, string> = {};
    for (const row of rows) {
      secrets[row.name] = await decrypt(row.encrypted_value, this.encryptionKey!);
    }

    return secrets;
  }

  /**
   * List all secrets (metadata only, no values)
   */
  listSecrets(): SecretMetadata[] {
    if (!this.isInitialized()) {
      throw new VaultNotInitializedError();
    }
    this.open();
    this.migrateSensitiveColumn();

    const rows = this.db
      .prepare(
        "SELECT name, created_at, updated_at, description, tags, sensitive FROM secrets ORDER BY name"
      )
      .all() as Array<{
      name: string;
      created_at: string;
      updated_at: string;
      description: string | null;
      tags: string | null;
      sensitive: number | null;
    }>;

    return rows.map((row) => ({
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      description: row.description,
      tags: row.tags ? JSON.parse(row.tags) : [],
      sensitive: row.sensitive !== 0,  // default to true for old entries
    }));
  }

  /**
   * Delete a secret
   */
  async deleteSecret(name: string): Promise<boolean> {
    this.ensureUnlocked();

    const result = this.db
      .prepare("DELETE FROM secrets WHERE name = ?")
      .run(name);

    if (result.changes === 0) {
      throw new SecretNotFoundError(name);
    }

    this.logAudit("SECRET_DELETED", name);
    return true;
  }

  /**
   * Get count of secrets
   */
  getSecretCount(): number {
    if (!this.isInitialized()) {
      return 0;
    }
    this.open();

    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM secrets")
      .get() as { count: number };

    return row.count;
  }

  /**
   * Check if a variable name looks like a secret (vs a config value)
   */
  private isSecretName(name: string): boolean {
    const upperName = name.toUpperCase();
    const secretPatterns = [
      'SECRET', 'KEY', 'TOKEN', 'PASSWORD', 'PASS', 'PWD',
      'CREDENTIAL', 'PRIVATE', 'AUTH', 'API_KEY', 'APIKEY',
      'ACCESS_KEY', 'ACCESSKEY', 'CLIENT_SECRET'
    ];
    return secretPatterns.some(pattern => upperName.includes(pattern));
  }

  /**
   * Check if a variable name looks like a non-secret config value
   */
  private isConfigName(name: string): boolean {
    const upperName = name.toUpperCase();
    const configPatterns = [
      'URL', 'HOST', 'PORT', 'ENDPOINT', 'DOMAIN', 'REGION',
      'ZONE', 'ENV', 'MODE', 'DEBUG', 'LOG', 'TIMEOUT',
      'USERNAME', 'USER', 'EMAIL', 'ID', 'CLIENT_ID', 'APP_ID',
      'PROJECT', 'BUCKET', 'DATABASE', 'DB_NAME', 'TABLE'
    ];
    return configPatterns.some(pattern => upperName.includes(pattern));
  }

  /**
   * Import secrets from .env file content
   * @param content - The .env file content
   * @param options - Import options
   * @param options.secretsOnly - Only import values that look like secrets (contain KEY, SECRET, TOKEN, etc.)
   * @returns [importedCount, importedNames, skippedNames]
   */
  async importFromEnv(
    content: string,
    options: { secretsOnly?: boolean } = {}
  ): Promise<{ secrets: string[]; credentials: string[]; skipped: string[] }> {
    this.ensureUnlocked();

    const lines = content.split("\n");
    const secrets: string[] = [];
    const credentials: string[] = [];
    const skipped: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      // Parse KEY=VALUE
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }

      const name = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();

      // Remove quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!name || !value) {
        continue;
      }

      // Filter if secretsOnly mode is enabled
      if (options.secretsOnly) {
        if (!this.isSecretName(name)) {
          skipped.push(name);
          continue;
        }
      }

      // Auto-classify: secret-like names are sensitive (masked),
      // everything else is a credential (stored but visible in listings)
      const sensitive = this.isSecretName(name);
      await this.addSecret(name, value, { sensitive });

      if (sensitive) {
        secrets.push(name);
      } else {
        credentials.push(name);
      }
    }

    return { secrets, credentials, skipped };
  }

  // ============================================================================
  // Audit Log
  // ============================================================================

  /**
   * Log an audit event
   */
  logAudit(action: AuditAction, secretName?: string, details?: string): void {
    if (!this.db) return;

    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO audit_log (timestamp, action, secret_name, details) VALUES (?, ?, ?, ?)"
      )
      .run(now, action, secretName || null, details || null);
  }

  /**
   * Get audit log entries
   */
  getAuditLog(limit: number = 50): AuditEntry[] {
    if (!this.isInitialized()) {
      return [];
    }
    this.open();

    const rows = this.db
      .prepare(
        "SELECT id, timestamp, action, secret_name, details FROM audit_log ORDER BY id DESC LIMIT ?"
      )
      .all(limit) as Array<{
      id: number;
      timestamp: string;
      action: string;
      secret_name: string | null;
      details: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      action: row.action,
      secretName: row.secret_name,
      details: row.details,
    }));
  }

  // ============================================================================
  // Rotation Configuration
  // ============================================================================

  /**
   * Migrate existing vaults to add rotation tables
   */
  migrateRotationTables(): void {
    this.open();
    this.db.exec(SCHEMA.rotationConfig);
    this.db.exec(SCHEMA.rotationHistory);
  }

  /**
   * Migrate to add sensitive column to secrets table
   */
  private migrateSensitiveColumn(): void {
    this.open();
    // Check if column exists
    const tableInfo = this.db.prepare("PRAGMA table_info(secrets)").all() as Array<{ name: string }>;
    const hasSensitive = tableInfo.some((col) => col.name === "sensitive");
    if (!hasSensitive) {
      this.db.exec("ALTER TABLE secrets ADD COLUMN sensitive INTEGER DEFAULT 1");
    }
  }

  /**
   * Set rotation configuration for a secret
   */
  setRotationConfig(config: RotationConfig): void {
    this.ensureUnlocked();
    this.migrateRotationTables();

    const stmt = this.db.prepare(`
      INSERT INTO rotation_config (secret_name, provider_type, schedule_days, last_rotated, next_rotation, enabled, provider_config)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(secret_name) DO UPDATE SET
        provider_type = excluded.provider_type,
        schedule_days = excluded.schedule_days,
        last_rotated = excluded.last_rotated,
        next_rotation = excluded.next_rotation,
        enabled = excluded.enabled,
        provider_config = excluded.provider_config
    `);

    stmt.run(
      config.secretName,
      config.providerType,
      config.scheduleDays,
      config.lastRotated,
      config.nextRotation,
      config.enabled ? 1 : 0,
      JSON.stringify(config.providerConfig)
    );
  }

  /**
   * Get rotation configuration for a secret
   */
  getRotationConfig(secretName: string): RotationConfig | null {
    this.open();
    this.migrateRotationTables();

    const row = this.db
      .prepare("SELECT * FROM rotation_config WHERE secret_name = ?")
      .get(secretName) as {
      secret_name: string;
      provider_type: string;
      schedule_days: number;
      last_rotated: string | null;
      next_rotation: string | null;
      enabled: number;
      provider_config: string;
    } | null;

    if (!row) return null;

    return {
      secretName: row.secret_name,
      providerType: row.provider_type as ProviderType,
      scheduleDays: row.schedule_days,
      lastRotated: row.last_rotated,
      nextRotation: row.next_rotation,
      enabled: row.enabled === 1,
      providerConfig: JSON.parse(row.provider_config) as ProviderConfig,
    };
  }

  /**
   * List all rotation configurations
   */
  listRotationConfigs(): RotationConfig[] {
    this.open();
    this.migrateRotationTables();

    const rows = this.db
      .prepare("SELECT * FROM rotation_config ORDER BY secret_name")
      .all() as Array<{
      secret_name: string;
      provider_type: string;
      schedule_days: number;
      last_rotated: string | null;
      next_rotation: string | null;
      enabled: number;
      provider_config: string;
    }>;

    return rows.map((row) => ({
      secretName: row.secret_name,
      providerType: row.provider_type as ProviderType,
      scheduleDays: row.schedule_days,
      lastRotated: row.last_rotated,
      nextRotation: row.next_rotation,
      enabled: row.enabled === 1,
      providerConfig: JSON.parse(row.provider_config) as ProviderConfig,
    }));
  }

  /**
   * Enable rotation for a secret
   */
  enableRotation(secretName: string): void {
    this.ensureUnlocked();
    this.migrateRotationTables();
    this.db
      .prepare("UPDATE rotation_config SET enabled = 1 WHERE secret_name = ?")
      .run(secretName);
  }

  /**
   * Disable rotation for a secret
   */
  disableRotation(secretName: string): void {
    this.ensureUnlocked();
    this.migrateRotationTables();
    this.db
      .prepare("UPDATE rotation_config SET enabled = 0 WHERE secret_name = ?")
      .run(secretName);
  }

  /**
   * Delete rotation configuration for a secret
   */
  deleteRotationConfig(secretName: string): void {
    this.ensureUnlocked();
    this.migrateRotationTables();
    this.db
      .prepare("DELETE FROM rotation_config WHERE secret_name = ?")
      .run(secretName);
  }

  /**
   * Update last rotated and next rotation dates
   */
  updateRotationDates(secretName: string, lastRotated: string, nextRotation: string): void {
    this.ensureUnlocked();
    this.migrateRotationTables();
    this.db
      .prepare("UPDATE rotation_config SET last_rotated = ?, next_rotation = ? WHERE secret_name = ?")
      .run(lastRotated, nextRotation, secretName);
  }

  /**
   * Get secrets due for rotation
   */
  getDueRotations(): RotationConfig[] {
    this.open();
    this.migrateRotationTables();

    const now = new Date().toISOString();
    const rows = this.db
      .prepare(`
        SELECT * FROM rotation_config 
        WHERE enabled = 1 AND (next_rotation IS NULL OR next_rotation <= ?)
        ORDER BY next_rotation ASC
      `)
      .all(now) as Array<{
      secret_name: string;
      provider_type: string;
      schedule_days: number;
      last_rotated: string | null;
      next_rotation: string | null;
      enabled: number;
      provider_config: string;
    }>;

    return rows.map((row) => ({
      secretName: row.secret_name,
      providerType: row.provider_type as ProviderType,
      scheduleDays: row.schedule_days,
      lastRotated: row.last_rotated,
      nextRotation: row.next_rotation,
      enabled: row.enabled === 1,
      providerConfig: JSON.parse(row.provider_config) as ProviderConfig,
    }));
  }

  // ============================================================================
  // Rotation History
  // ============================================================================

  /**
   * Add a rotation history entry
   */
  addRotationHistory(entry: Omit<RotationHistoryEntry, 'id'>): void {
    this.open();
    this.migrateRotationTables();

    this.db
      .prepare(`
        INSERT INTO rotation_history (secret_name, timestamp, status, provider_type, error_message)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        entry.secretName,
        entry.timestamp,
        entry.status,
        entry.providerType,
        entry.errorMessage
      );
  }

  /**
   * Get rotation history entries
   */
  getRotationHistory(secretName?: string, limit: number = 50): RotationHistoryEntry[] {
    this.open();
    this.migrateRotationTables();

    let query = "SELECT * FROM rotation_history";
    const params: (string | number)[] = [];

    if (secretName) {
      query += " WHERE secret_name = ?";
      params.push(secretName);
    }

    query += " ORDER BY id DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: number;
      secret_name: string;
      timestamp: string;
      status: string;
      provider_type: string;
      error_message: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      secretName: row.secret_name,
      timestamp: row.timestamp,
      status: row.status as 'success' | 'failed',
      providerType: row.provider_type as ProviderType,
      errorMessage: row.error_message,
    }));
  }
}

/**
 * Find the vault path (local or global)
 */
export function findVaultPath(): string | null {
  // Check local first
  const localPath = join(process.cwd(), LOCAL_DB_DIR, DEFAULT_DB_NAME);
  if (existsSync(localPath)) {
    return localPath;
  }

  // Check global
  const globalPath = join(DEFAULT_DB_DIR, DEFAULT_DB_NAME);
  if (existsSync(globalPath)) {
    return globalPath;
  }

  return null;
}
