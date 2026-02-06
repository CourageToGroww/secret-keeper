import { SecretDatabase } from "../database";
import {
  RotationConfig,
  RotationResult,
  RotationHistoryEntry,
  ProviderType,
  ProviderConfig,
  RotationError,
} from "../types";
import { providerRegistry } from "./providers";

/**
 * Manages secret rotation configurations and executes rotations
 */
export class RotationManager {
  constructor(private db: SecretDatabase) {}

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Configure rotation for a secret
   */
  async configureRotation(
    secretName: string,
    providerType: ProviderType,
    scheduleDays: number,
    providerConfig: ProviderConfig
  ): Promise<void> {
    const provider = providerRegistry.get(providerType);
    if (!provider) {
      throw new RotationError(`Unknown provider type: ${providerType}`);
    }

    // Validate provider config
    const isValid = await provider.validateConfig(providerConfig);
    if (!isValid) {
      throw new RotationError(`Invalid provider configuration for ${providerType}`);
    }

    // Calculate next rotation date
    const nextRotation = this.calculateNextRotation(null, scheduleDays);

    const config: RotationConfig = {
      secretName,
      providerType,
      scheduleDays,
      lastRotated: null,
      nextRotation,
      enabled: true,
      providerConfig,
    };

    this.db.setRotationConfig(config);
  }

  /**
   * Get rotation configuration for a secret
   */
  getRotationConfig(secretName: string): RotationConfig | null {
    return this.db.getRotationConfig(secretName);
  }

  /**
   * List all rotation configurations
   */
  listRotationConfigs(): RotationConfig[] {
    return this.db.listRotationConfigs();
  }

  /**
   * Enable rotation for a secret
   */
  enableRotation(secretName: string): void {
    this.db.enableRotation(secretName);
  }

  /**
   * Disable rotation for a secret
   */
  disableRotation(secretName: string): void {
    this.db.disableRotation(secretName);
  }

  /**
   * Delete rotation configuration
   */
  deleteRotationConfig(secretName: string): void {
    this.db.deleteRotationConfig(secretName);
  }

  // ============================================================================
  // Rotation Execution
  // ============================================================================

  /**
   * Rotate a secret now
   */
  async rotateNow(secretName: string): Promise<RotationResult> {
    const config = this.db.getRotationConfig(secretName);
    if (!config) {
      return {
        success: false,
        secretName,
        error: `No rotation configuration found for ${secretName}`,
      };
    }

    const provider = providerRegistry.get(config.providerType);
    if (!provider) {
      return {
        success: false,
        secretName,
        error: `Unknown provider type: ${config.providerType}`,
      };
    }

    const timestamp = new Date().toISOString();

    try {
      // Get current secret value
      const currentValue = await this.db.getSecret(secretName);

      // Execute rotation
      const newValue = await provider.rotate(config, currentValue);

      // Update secret with new value
      await this.db.addSecret(secretName, newValue);

      // Update rotation dates
      const nextRotation = this.calculateNextRotation(timestamp, config.scheduleDays);
      this.db.updateRotationDates(secretName, timestamp, nextRotation);

      // Log success
      this.db.addRotationHistory({
        secretName,
        timestamp,
        status: "success",
        providerType: config.providerType,
        errorMessage: null,
      });

      return {
        success: true,
        secretName,
        newValue,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log failure
      this.db.addRotationHistory({
        secretName,
        timestamp,
        status: "failed",
        providerType: config.providerType,
        errorMessage,
      });

      return {
        success: false,
        secretName,
        error: errorMessage,
      };
    }
  }

  /**
   * Test rotation without applying
   */
  async testRotation(secretName: string): Promise<{ success: boolean; error?: string }> {
    const config = this.db.getRotationConfig(secretName);
    if (!config) {
      return {
        success: false,
        error: `No rotation configuration found for ${secretName}`,
      };
    }

    const provider = providerRegistry.get(config.providerType);
    if (!provider) {
      return {
        success: false,
        error: `Unknown provider type: ${config.providerType}`,
      };
    }

    try {
      const currentValue = await this.db.getSecret(secretName);
      const success = await provider.testRotation(config, currentValue);

      return {
        success,
        error: success ? undefined : "Test rotation failed",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check for rotations that are due
   */
  checkDueRotations(): RotationConfig[] {
    return this.db.getDueRotations();
  }

  /**
   * Run all due rotations
   */
  async runDueRotations(): Promise<RotationResult[]> {
    const dueConfigs = this.checkDueRotations();
    const results: RotationResult[] = [];

    for (const config of dueConfigs) {
      const result = await this.rotateNow(config.secretName);
      results.push(result);
    }

    return results;
  }

  // ============================================================================
  // History
  // ============================================================================

  /**
   * Get rotation history
   */
  getHistory(secretName?: string, limit: number = 50): RotationHistoryEntry[] {
    return this.db.getRotationHistory(secretName, limit);
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Calculate next rotation date
   */
  private calculateNextRotation(lastRotated: string | null, scheduleDays: number): string {
    const baseDate = lastRotated ? new Date(lastRotated) : new Date();
    const nextDate = new Date(baseDate);
    nextDate.setDate(nextDate.getDate() + scheduleDays);
    return nextDate.toISOString();
  }

  /**
   * Get available provider types
   */
  getProviderTypes(): ProviderType[] {
    return providerRegistry.types();
  }

  /**
   * Get provider display name
   */
  getProviderDisplayName(type: ProviderType): string {
    const provider = providerRegistry.get(type);
    return provider?.displayName || type;
  }
}

// Re-export
export { providerRegistry } from "./providers";
export { RotationScheduler } from "./scheduler";
