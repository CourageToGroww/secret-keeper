import { ProviderType } from "../../types";
import { SecretProvider } from "./base";
import { CustomProvider } from "./custom";
import { OpenAIProvider } from "./openai";
import { AWSProvider } from "./aws";
import { GitHubProvider } from "./github";

/**
 * Registry of available rotation providers
 */
class ProviderRegistry {
  private providers: Map<ProviderType, SecretProvider> = new Map();

  constructor() {
    this.register(new CustomProvider());
    this.register(new OpenAIProvider());
    this.register(new AWSProvider());
    this.register(new GitHubProvider());
  }

  /**
   * Register a provider
   */
  register(provider: SecretProvider): void {
    this.providers.set(provider.type, provider);
  }

  /**
   * Get a provider by type
   */
  get(type: ProviderType): SecretProvider | undefined {
    return this.providers.get(type);
  }

  /**
   * Get all registered providers
   */
  all(): SecretProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get all provider types
   */
  types(): ProviderType[] {
    return Array.from(this.providers.keys());
  }
}

// Singleton instance
export const providerRegistry = new ProviderRegistry();

// Re-export types
export type { SecretProvider } from "./base";
export { CustomProvider } from "./custom";
export { OpenAIProvider } from "./openai";
export { AWSProvider } from "./aws";
export { GitHubProvider } from "./github";
