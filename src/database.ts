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
  VaultLockedError,
  SecretNotFoundError,
  InvalidPasswordError,
} from "./types";
import { encrypt, decrypt, hashPassword, verifyPassword } from "./crypto";

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
      tags TEXT
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
};

// ============================================================================
// SecretDatabase Class
// ============================================================================

export class SecretDatabase {
  private db: Database;
  private dbPath: string;
  private masterPassword: string | null = null;

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
    this.masterPassword = null;
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
   * Initialize a new vault with the given master password
   */
  async initialize(masterPassword: string): Promise<boolean> {
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

    // Store password hash and metadata
    const pwHash = hashPassword(masterPassword);
    const now = new Date().toISOString();

    const insert = this.db.prepare(
      "INSERT INTO vault_config (key, value) VALUES (?, ?)"
    );
    insert.run("password_hash", pwHash);
    insert.run("created_at", now);
    insert.run("version", "1");

    this.masterPassword = masterPassword;
    this.logAudit("VAULT_INITIALIZED");

    return true;
  }

  /**
   * Unlock the vault with the master password
   */
  async unlock(masterPassword: string): Promise<boolean> {
    if (!this.isInitialized()) {
      throw new VaultNotInitializedError();
    }

    this.open();

    const row = this.db
      .prepare("SELECT value FROM vault_config WHERE key = ?")
      .get("password_hash") as { value: string } | null;

    if (!row || !verifyPassword(masterPassword, row.value)) {
      throw new InvalidPasswordError();
    }

    this.masterPassword = masterPassword;
    this.logAudit("VAULT_UNLOCKED");
    return true;
  }

  /**
   * Lock the vault (clear master password from memory)
   */
  lock(): void {
    if (this.masterPassword) {
      this.logAudit("VAULT_LOCKED");
    }
    this.masterPassword = null;
  }

  /**
   * Check if the vault is unlocked
   */
  isUnlocked(): boolean {
    return this.masterPassword !== null;
  }

  /**
   * Ensure vault is unlocked before operations
   */
  private ensureUnlocked(): void {
    if (!this.masterPassword) {
      throw new VaultLockedError();
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

    const encryptedValue = await encrypt(value, this.masterPassword!);
    const now = new Date().toISOString();
    const tags = options.tags ? JSON.stringify(options.tags) : null;

    const stmt = this.db.prepare(`
      INSERT INTO secrets (name, encrypted_value, created_at, updated_at, description, tags)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        encrypted_value = excluded.encrypted_value,
        updated_at = excluded.updated_at,
        description = COALESCE(excluded.description, description),
        tags = COALESCE(excluded.tags, tags)
    `);

    stmt.run(name, encryptedValue, now, now, options.description || null, tags);
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

    return decrypt(row.encrypted_value, this.masterPassword!);
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
      secrets[row.name] = await decrypt(row.encrypted_value, this.masterPassword!);
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

    const rows = this.db
      .prepare(
        "SELECT name, created_at, updated_at, description, tags FROM secrets ORDER BY name"
      )
      .all() as Array<{
      name: string;
      created_at: string;
      updated_at: string;
      description: string | null;
      tags: string | null;
    }>;

    return rows.map((row) => ({
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      description: row.description,
      tags: row.tags ? JSON.parse(row.tags) : [],
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
   * Import secrets from .env file content
   */
  async importFromEnv(content: string): Promise<[number, string[]]> {
    this.ensureUnlocked();

    const lines = content.split("\n");
    const imported: string[] = [];

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

      if (name && value) {
        await this.addSecret(name, value);
        imported.push(name);
      }
    }

    return [imported.length, imported];
  }

  // ============================================================================
  // Password Management
  // ============================================================================

  /**
   * Change the master password (re-encrypts all secrets)
   */
  async changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<boolean> {
    // Verify current password
    await this.unlock(currentPassword);

    // Get all secrets decrypted
    const secrets = await this.getAllSecrets();

    // Update password hash
    const newHash = hashPassword(newPassword);
    this.db
      .prepare("UPDATE vault_config SET value = ? WHERE key = ?")
      .run(newHash, "password_hash");

    // Re-encrypt all secrets with new password
    this.masterPassword = newPassword;
    for (const [name, value] of Object.entries(secrets)) {
      const encryptedValue = await encrypt(value, newPassword);
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE secrets SET encrypted_value = ?, updated_at = ? WHERE name = ?")
        .run(encryptedValue, now, name);
    }

    this.logAudit("PASSWORD_CHANGED");
    return true;
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
