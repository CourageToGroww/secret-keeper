import { ProviderType, ProviderConfig, RotationConfig, OpenAIConfig, RotationError } from "../../types";
import { BaseProvider } from "./base";

/**
 * OpenAI API key rotation provider
 * Creates a new API key and optionally deletes the old one
 */
export class OpenAIProvider extends BaseProvider {
  readonly type: ProviderType = "openai";
  readonly displayName = "OpenAI";

  private readonly baseUrl = "https://api.openai.com/v1";

  async rotate(config: RotationConfig, currentValue: string): Promise<string> {
    const openaiConfig = config.providerConfig as OpenAIConfig;

    // Use the current API key to create a new one
    const apiKey = currentValue;

    if (!apiKey || !apiKey.startsWith("sk-")) {
      throw new RotationError("Invalid OpenAI API key format");
    }

    // Create a new API key
    // Note: OpenAI's API doesn't currently support programmatic key creation
    // This would require using the dashboard API or a workaround
    // For now, we'll document this limitation and provide a placeholder

    // List existing keys to verify access
    const listResponse = await this.httpRequest(`${this.baseUrl}/dashboard/user/api_keys`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (listResponse.status !== 200) {
      // If the keys endpoint isn't available, try a simpler validation
      const modelsResponse = await this.httpRequest(`${this.baseUrl}/models`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
      });

      if (modelsResponse.status === 401) {
        throw new RotationError("Invalid API key - unable to authenticate");
      }

      // Since OpenAI doesn't support programmatic key creation via API,
      // we throw an error explaining the limitation
      throw new RotationError(
        "OpenAI does not support programmatic API key creation. " +
        "Please use a custom command provider with the OpenAI dashboard, " +
        "or rotate keys manually via https://platform.openai.com/api-keys"
      );
    }

    // If we got here, the dashboard API is accessible (unlikely without special access)
    // Create new key
    const createResponse = await this.httpRequest(`${this.baseUrl}/dashboard/user/api_keys`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `rotated-${Date.now()}`,
      }),
    });

    if (createResponse.status !== 200 && createResponse.status !== 201) {
      throw new RotationError(`Failed to create new API key: ${JSON.stringify(createResponse.data)}`);
    }

    const newKey = createResponse.data.key?.key || createResponse.data.api_key;

    if (!newKey) {
      throw new RotationError("Failed to extract new API key from response");
    }

    return newKey;
  }

  async validateConfig(config: ProviderConfig): Promise<boolean> {
    if (config.type !== "openai") {
      return false;
    }

    const openaiConfig = config as OpenAIConfig;
    return !!openaiConfig.apiKeyName;
  }

  async testRotation(config: RotationConfig, currentValue: string): Promise<boolean> {
    // Test that the API key is valid by listing models
    try {
      const response = await this.httpRequest(`${this.baseUrl}/models`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${currentValue}`,
        },
      });

      return response.status === 200;
    } catch {
      return false;
    }
  }
}
