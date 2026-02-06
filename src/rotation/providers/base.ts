import { ProviderType, ProviderConfig, RotationConfig } from "../../types";

/**
 * Interface for secret rotation providers
 */
export interface SecretProvider {
  readonly type: ProviderType;
  readonly displayName: string;

  /**
   * Rotate the secret, returns new value
   */
  rotate(config: RotationConfig, currentValue: string): Promise<string>;

  /**
   * Validate configuration before saving
   */
  validateConfig(config: ProviderConfig): Promise<boolean>;

  /**
   * Test rotation without applying (dry run)
   */
  testRotation(config: RotationConfig, currentValue: string): Promise<boolean>;
}

/**
 * Base class with common provider utilities
 */
export abstract class BaseProvider implements SecretProvider {
  abstract readonly type: ProviderType;
  abstract readonly displayName: string;

  abstract rotate(config: RotationConfig, currentValue: string): Promise<string>;
  abstract validateConfig(config: ProviderConfig): Promise<boolean>;

  /**
   * Default test rotation - just validates config
   */
  async testRotation(config: RotationConfig, currentValue: string): Promise<boolean> {
    return this.validateConfig(config.providerConfig);
  }

  /**
   * Execute a shell command and return stdout
   */
  protected async executeCommand(command: string): Promise<string> {
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`Command failed (exit ${exitCode}): ${stderr || stdout}`);
    }

    return stdout.trim();
  }

  /**
   * Make an HTTP request
   */
  protected async httpRequest(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {}
  ): Promise<{ status: number; data: any }> {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
    });

    const data = await response.json();
    return { status: response.status, data };
  }
}
