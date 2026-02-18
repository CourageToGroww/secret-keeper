import { randomBytes } from "crypto";
import { unlink } from "fs/promises";
import { stat, open } from "fs/promises";
import {
  SALT_SIZE,
  NONCE_SIZE,
  KEY_SIZE,
  ITERATIONS,
  CryptoError,
  DecryptionError,
} from "./types";

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Generate a random salt for key derivation
 */
export function generateSalt(): Uint8Array {
  return new Uint8Array(randomBytes(SALT_SIZE));
}

/**
 * Derive an AES-256 key from password using PBKDF2-SHA256
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: KEY_SIZE * 8 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ============================================================================
// Encryption / Decryption
// ============================================================================

/**
 * Encrypt plaintext using AES-256-GCM
 * Returns base64-encoded string: salt (32) + nonce (12) + ciphertext
 */
export async function encrypt(plaintext: string, password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = generateSalt();
  const nonce = new Uint8Array(randomBytes(NONCE_SIZE));
  const key = await deriveKey(password, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    encoder.encode(plaintext)
  );

  // Concatenate salt + nonce + ciphertext
  const result = new Uint8Array(SALT_SIZE + NONCE_SIZE + ciphertext.byteLength);
  result.set(salt, 0);
  result.set(nonce, SALT_SIZE);
  result.set(new Uint8Array(ciphertext), SALT_SIZE + NONCE_SIZE);

  return Buffer.from(result).toString("base64");
}

/**
 * Decrypt base64-encoded ciphertext using AES-256-GCM
 */
export async function decrypt(encryptedData: string, password: string): Promise<string> {
  try {
    const data = Buffer.from(encryptedData, "base64");

    if (data.length < SALT_SIZE + NONCE_SIZE + 16) {
      throw new DecryptionError("Invalid encrypted data length");
    }

    const salt = new Uint8Array(data.subarray(0, SALT_SIZE));
    const nonce = new Uint8Array(data.subarray(SALT_SIZE, SALT_SIZE + NONCE_SIZE));
    const ciphertext = new Uint8Array(data.subarray(SALT_SIZE + NONCE_SIZE));

    const key = await deriveKey(password, salt);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext
    );

    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw error;
    }
    throw new DecryptionError();
  }
}

// ============================================================================
// Master Key Generation
// ============================================================================

/**
 * Generate a random master key (32-char URL-safe string)
 */
export function generateMasterKey(): string {
  return randomBytes(24).toString("base64url");
}

// ============================================================================
// Secure File Deletion
// ============================================================================

/**
 * Securely delete a file by overwriting with random data before unlinking
 * @param filepath - Path to the file to delete
 * @param passes - Number of random overwrite passes (default: 3)
 */
export async function secureDelete(filepath: string, passes: number = 3): Promise<boolean> {
  try {
    const fileStats = await stat(filepath);
    const fileSize = fileStats.size;

    const fileHandle = await open(filepath, "r+");

    try {
      // Random overwrite passes
      for (let i = 0; i < passes; i++) {
        const randomData = randomBytes(fileSize);
        await fileHandle.write(randomData, 0, fileSize, 0);
        await fileHandle.sync();
      }

      // Final zero pass
      const zeros = Buffer.alloc(fileSize, 0);
      await fileHandle.write(zeros, 0, fileSize, 0);
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    // Delete the file
    await unlink(filepath);
    return true;
  } catch (error) {
    // If secure delete fails, try regular delete
    try {
      await unlink(filepath);
      return true;
    } catch {
      return false;
    }
  }
}
