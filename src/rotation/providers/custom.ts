import { ProviderType, ProviderConfig, RotationConfig, CustomConfig, RotationError } from "../../types";
import { BaseProvider } from "./base";

/**
 * Custom command-based rotation provider
 * Executes user-provided shell commands to rotate secrets
 */
export class CustomProvider extends BaseProvider {
  readonly type: ProviderType = "custom";
  readonly displayName = "Custom Command";

  async rotate(config: RotationConfig, currentValue: string): Promise<string> {
    const customConfig = config.providerConfig as CustomConfig;

    if (!customConfig.rotateCommand) {
      throw new RotationError("No rotate command configured");
    }

    // Set current value as environment variable for the command
    const env = { ...process.env, CURRENT_SECRET_VALUE: currentValue };
    
    const proc = Bun.spawn(["sh", "-c", customConfig.rotateCommand], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new RotationError(`Rotate command failed (exit ${exitCode}): ${stderr || stdout}`);
    }

    const newValue = stdout.trim();

    if (!newValue) {
      throw new RotationError("Rotate command produced empty output");
    }

    // Validate if validation command is provided
    if (customConfig.validateCommand) {
      const validateEnv = { ...process.env, SECRET_VALUE: newValue };
      
      const validateProc = Bun.spawn(["sh", "-c", customConfig.validateCommand], {
        stdout: "pipe",
        stderr: "pipe",
        env: validateEnv,
      });

      const validateExit = await validateProc.exited;

      if (validateExit !== 0) {
        throw new RotationError("New secret failed validation");
      }
    }

    return newValue;
  }

  async validateConfig(config: ProviderConfig): Promise<boolean> {
    if (config.type !== "custom") {
      return false;
    }

    const customConfig = config as CustomConfig;
    return !!customConfig.rotateCommand;
  }

  async testRotation(config: RotationConfig, currentValue: string): Promise<boolean> {
    const customConfig = config.providerConfig as CustomConfig;

    if (!customConfig.rotateCommand) {
      return false;
    }

    // Test that the command executes without error (dry run mode)
    // We add DRY_RUN=1 env var so commands can optionally skip actual rotation
    const env = { 
      ...process.env, 
      CURRENT_SECRET_VALUE: currentValue,
      DRY_RUN: "1"
    };

    try {
      const proc = Bun.spawn(["sh", "-c", customConfig.rotateCommand], {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });

      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }
}
