// ============================================================================
// Crypto Constants
// ============================================================================

export const SALT_SIZE = 32;
export const NONCE_SIZE = 12;
export const KEY_SIZE = 32;
export const ITERATIONS = 600_000;
export const PASSWORD_HASH_PREFIX = "secret-keeper-v1:";

// ============================================================================
// Path Constants
// ============================================================================

export const SOCKET_DIR = "/tmp/secret-keeper";
export const SOCKET_NAME = "sk.sock";
export const DEFAULT_SOCKET_PATH = `${SOCKET_DIR}/${SOCKET_NAME}`;

export const DEFAULT_DB_DIR = `${process.env.HOME}/.secret-keeper`;
export const DEFAULT_DB_NAME = "secrets.db";
export const LOCAL_DB_DIR = ".secret-keeper";

export const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10 MB

// ============================================================================
// Vault Types
// ============================================================================

export interface VaultConfig {
  passwordHash: string;
  createdAt: string;
  version: string;
}

export interface EncryptedSecret {
  name: string;
  encryptedValue: string;
  createdAt: string;
  updatedAt: string;
  description: string | null;
  tags: string[];
}

export interface SecretMetadata {
  name: string;
  createdAt: string;
  updatedAt: string;
  description: string | null;
  tags: string[];
}

export interface SecretOptions {
  description?: string;
  tags?: string[];
}

export interface AuditEntry {
  id?: number;
  timestamp: string;
  action: string;
  secretName: string | null;
  details: string | null;
}

export type AuditAction =
  | "VAULT_INITIALIZED"
  | "VAULT_UNLOCKED"
  | "VAULT_LOCKED"
  | "SECRET_ADDED"
  | "SECRET_DELETED"
  | "SECRETS_EXPORTED"
  | "PASSWORD_CHANGED";

// ============================================================================
// Daemon Types
// ============================================================================

export interface ExecRequest {
  action: "exec";
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface ListRequest {
  action: "list";
}

export interface PingRequest {
  action: "ping";
}

export interface ShutdownRequest {
  action: "shutdown";
}

export type DaemonRequest = ExecRequest | ListRequest | PingRequest | ShutdownRequest;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  blocked: boolean;
  blockReason: string;
}

export interface ListResponse {
  secrets: string[];
}

export interface PingResponse {
  status: "ok";
  secretsLoaded: number;
}

export interface ErrorResponse {
  error: string;
}

export type DaemonResponse = CommandResult | ListResponse | PingResponse | ErrorResponse;

// ============================================================================
// CLI Types
// ============================================================================

export type ExportFormat = "shell" | "docker" | "json";

// ============================================================================
// Error Classes
// ============================================================================

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

export class DecryptionError extends CryptoError {
  constructor(message: string = "Decryption failed - invalid password or corrupted data") {
    super(message);
    this.name = "DecryptionError";
  }
}

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class VaultNotInitializedError extends DatabaseError {
  constructor() {
    super("Vault not initialized. Run 'secret-keeper init' first.");
    this.name = "VaultNotInitializedError";
  }
}

export class VaultLockedError extends DatabaseError {
  constructor() {
    super("Vault is locked. Please provide the master password.");
    this.name = "VaultLockedError";
  }
}

export class SecretNotFoundError extends DatabaseError {
  constructor(name: string) {
    super(`Secret '${name}' not found.`);
    this.name = "SecretNotFoundError";
  }
}

export class InvalidPasswordError extends DatabaseError {
  constructor() {
    super("Invalid master password.");
    this.name = "InvalidPasswordError";
  }
}

export class DaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonError";
  }
}

export class DaemonNotRunningError extends DaemonError {
  constructor() {
    super("Daemon not running. Start it with 'secret-keeper daemon'.");
    this.name = "DaemonNotRunningError";
  }
}

export class CommandBlockedError extends DaemonError {
  constructor(reason: string) {
    super(`Command blocked: ${reason}`);
    this.name = "CommandBlockedError";
  }
}
