import { existsSync, mkdirSync, unlinkSync, chmodSync, appendFileSync } from "fs";
import { join } from "path";
import { Socket } from "bun";
import {
  SOCKET_DIR,
  DEFAULT_SOCKET_PATH,
  MAX_MESSAGE_SIZE,
  CommandResult,
  DaemonRequest,
  ListResponse,
  PingResponse,
  DaemonNotRunningError,
  getProjectSocketPath,
  findProjectSocketPath,
} from "./types";
import { SecretDatabase } from "./database";
import { RotationManager, RotationScheduler } from "./rotation";

// ============================================================================
// Blocked Commands & Patterns
// ============================================================================

const BLOCKED_COMMANDS = new Set([
  "env",
  "printenv",
  "export",
  "set",
  "xxd",
  "hexdump",
  "od",
  "base64",
  "history",
]);

const BLOCKED_PATTERNS = [
  /\becho\s+\$/i,
  /\bprintf\s+.*\$/i,
  /\bcat\s+\/proc\/\d+\/environ/i,
  /\$\{?\w+\}?\s*[|>]/,
  />\s*\/dev\/tcp/,
  /\bexport\b/i,
  /\bprintenv\b/i,
  /\bcompgen\s+-e/i,
  /\bdeclare\s+-x/i,
];

// ============================================================================
// CommandValidator
// ============================================================================

export class CommandValidator {
  /**
   * Validate a command, returns [isValid, reason]
   */
  validate(command: string): [boolean, string] {
    // Extract base command
    const parts = command.trim().split(/\s+/);
    if (parts.length === 0) {
      return [false, "Empty command"];
    }

    const baseCommand = parts[0].split("/").pop()?.toLowerCase() || "";

    // Check blocked commands
    if (BLOCKED_COMMANDS.has(baseCommand)) {
      return [false, `Command '${baseCommand}' is blocked for security`];
    }

    // Check blocked patterns
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return [false, `Command matches blocked pattern: ${pattern.source}`];
      }
    }

    return [true, ""];
  }
}

// ============================================================================
// OutputScrubber
// ============================================================================

export class OutputScrubber {
  private replacements: Array<[RegExp, string]> = [];

  constructor(secrets: Record<string, string>) {
    this.buildPatterns(secrets);
  }

  /**
   * Build regex patterns for all secret values
   */
  private buildPatterns(secrets: Record<string, string>): void {
    for (const [name, value] of Object.entries(secrets)) {
      // Skip very short values to avoid false positives
      if (value.length < 3) {
        continue;
      }

      const replacement = `[REDACTED:${name}]`;

      // Plain text (case-insensitive)
      const escapedValue = this.escapeRegex(value);
      this.replacements.push([new RegExp(escapedValue, "gi"), replacement]);

      // URL-encoded
      const urlEncoded = encodeURIComponent(value);
      if (urlEncoded !== value) {
        const escapedUrl = this.escapeRegex(urlEncoded);
        this.replacements.push([new RegExp(escapedUrl, "gi"), replacement]);
      }

      // Base64-encoded
      const base64Encoded = Buffer.from(value).toString("base64");
      if (base64Encoded.length >= 4) {
        const escapedBase64 = this.escapeRegex(base64Encoded);
        this.replacements.push([
          new RegExp(escapedBase64, "g"),
          `[REDACTED:${name}:base64]`,
        ]);
      }
    }
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Scrub all secret values from text
   */
  scrub(text: string): string {
    if (!text) return text;

    let result = text;
    for (const [pattern, replacement] of this.replacements) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }
}

// ============================================================================
// SecretKeeperDaemon (Server)
// ============================================================================

export class SecretKeeperDaemon {
  private socketPath: string;
  private secrets: Record<string, string> = {};
  private scrubber: OutputScrubber | null = null;
  private validator: CommandValidator;
  private server: ReturnType<typeof Bun.listen> | null = null;
  private running: boolean = false;
  private scheduler: RotationScheduler | null = null;
  private db: SecretDatabase | null = null;
  private logPath: string;

  constructor(socketPath?: string, projectPath?: string) {
    // Use project-specific socket if projectPath provided, otherwise use provided socketPath or detect
    this.socketPath = socketPath ?? (projectPath ? getProjectSocketPath(projectPath) : DEFAULT_SOCKET_PATH);
    this.validator = new CommandValidator();
    this.logPath = join(SOCKET_DIR, "rotation.log");
  }

  /**
   * Load secrets from database
   */
  async loadSecrets(db: SecretDatabase): Promise<void> {
    this.db = db;
    this.secrets = await db.getAllSecrets();
    this.scrubber = new OutputScrubber(this.secrets);
  }

  /**
   * Start the rotation scheduler
   */
  startScheduler(checkIntervalMs: number = 60 * 60 * 1000): void {
    if (!this.db) {
      console.error("[Scheduler] Cannot start scheduler: database not loaded");
      return;
    }

    const manager = new RotationManager(this.db);
    
    this.scheduler = new RotationScheduler(manager, {
      checkIntervalMs,
      onRotationComplete: (results) => {
        // Log rotation results
        const timestamp = new Date().toISOString();
        for (const result of results) {
          const logLine = `[${timestamp}] ${result.secretName}: ${result.success ? "SUCCESS" : `FAILED - ${result.error}`}\n`;
          try {
            appendFileSync(this.logPath, logLine);
          } catch {
            // Ignore logging errors
          }
          
          // Reload secrets if rotation was successful
          if (result.success && this.db) {
            this.reloadSecrets();
          }
        }
      },
    });

    this.scheduler.start();
    console.log(`[Scheduler] Started (checking every ${Math.round(checkIntervalMs / 60000)} minutes)`);
  }

  /**
   * Stop the rotation scheduler
   */
  stopScheduler(): void {
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
      console.log("[Scheduler] Stopped");
    }
  }

  /**
   * Reload secrets from database (e.g., after rotation)
   */
  private async reloadSecrets(): Promise<void> {
    if (!this.db) return;
    
    try {
      this.secrets = await this.db.getAllSecrets();
      this.scrubber = new OutputScrubber(this.secrets);
      console.log("[Daemon] Secrets reloaded after rotation");
    } catch (error) {
      console.error("[Daemon] Failed to reload secrets:", error);
    }
  }

  /**
   * Check if scheduler is running
   */
  isSchedulerRunning(): boolean {
    return this.scheduler?.isRunning() ?? false;
  }

  /**
   * Get count of loaded secrets
   */
  getSecretCount(): number {
    return Object.keys(this.secrets).length;
  }

  /**
   * Get list of secret names
   */
  getSecretNames(): string[] {
    return Object.keys(this.secrets);
  }

  /**
   * Execute a command with secrets injected
   */
  async executeCommand(
    command: string,
    cwd?: string,
    timeout: number = 300
  ): Promise<CommandResult> {
    // Validate command first
    const [isValid, reason] = this.validator.validate(command);
    if (!isValid) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `BLOCKED: ${reason}`,
        blocked: true,
        blockReason: reason,
      };
    }

    try {
      // Execute with secrets as environment variables
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd: cwd || process.cwd(),
        env: { ...process.env, ...this.secrets },
        stdout: "pipe",
        stderr: "pipe",
      });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        proc.kill();
      }, timeout * 1000);

      // Wait for completion
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timeoutId);

      // Scrub output
      const scrubbedStdout = this.scrubber?.scrub(stdout) || stdout;
      const scrubbedStderr = this.scrubber?.scrub(stderr) || stderr;

      return {
        exitCode: exitCode ?? 1,
        stdout: scrubbedStdout,
        stderr: scrubbedStderr,
        blocked: false,
        blockReason: "",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error executing command: ${message}`,
        blocked: false,
        blockReason: "",
      };
    }
  }

  /**
   * Handle a client request
   */
  private async handleRequest(
    request: DaemonRequest
  ): Promise<CommandResult | ListResponse | PingResponse | { error: string }> {
    switch (request.action) {
      case "exec":
        return this.executeCommand(request.command, request.cwd, request.timeout);

      case "list":
        return { secrets: this.getSecretNames() };

      case "ping":
        return { status: "ok", secretsLoaded: this.getSecretCount() };

      case "shutdown":
        this.stop();
        return { status: "ok", secretsLoaded: 0 };

      default:
        return { error: `Unknown action: ${(request as any).action}` };
    }
  }

  /**
   * Start the daemon server
   */
  start(): void {
    // Create socket directory
    if (!existsSync(SOCKET_DIR)) {
      mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
    }

    // Remove existing socket
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    this.running = true;

    // Create Unix socket server
    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        open: (socket) => {
          // Connection opened
        },
        data: async (socket, data) => {
          try {
            const request = JSON.parse(data.toString()) as DaemonRequest;
            const response = await this.handleRequest(request);
            socket.write(JSON.stringify(response));
            socket.end();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            socket.write(JSON.stringify({ error: message }));
            socket.end();
          }
        },
        close: (socket) => {
          // Connection closed
        },
        error: (socket, error) => {
          console.error("Socket error:", error);
        },
      },
    });

    // Set socket permissions
    chmodSync(this.socketPath, 0o600);

    // Handle shutdown signals
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  /**
   * Stop the daemon server
   */
  stop(): void {
    this.running = false;

    // Stop scheduler first
    this.stopScheduler();

    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    // Clean up socket file
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clear secrets from memory
    this.secrets = {};
    this.scrubber = null;
    this.db = null;
  }

  /**
   * Check if daemon is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

// ============================================================================
// DaemonClient
// ============================================================================

export class DaemonClient {
  private socketPath: string;

  constructor(socketPath?: string) {
    // Auto-detect project-specific socket if no path provided
    this.socketPath = socketPath ?? findProjectSocketPath();
  }

  /**
   * Check if daemon is running
   */
  isRunning(): boolean {
    return existsSync(this.socketPath);
  }

  /**
   * Send a request to the daemon
   */
  private async sendRequest<T>(request: DaemonRequest): Promise<T> {
    if (!this.isRunning()) {
      throw new DaemonNotRunningError();
    }

    return new Promise((resolve, reject) => {
      let resolved = false;
      let responseData = "";

      Bun.connect({
        unix: this.socketPath,
        socket: {
          open: (socket) => {
            socket.write(JSON.stringify(request));
            // Don't end here - wait for response
          },
          data: (socket, data) => {
            responseData += data.toString();
            try {
              const response = JSON.parse(responseData);
              resolved = true;
              socket.end();
              if (response.error) {
                reject(new Error(response.error));
              } else {
                resolve(response as T);
              }
            } catch {
              // Incomplete JSON, wait for more data
            }
          },
          close: () => {
            if (!resolved) {
              if (responseData) {
                try {
                  const response = JSON.parse(responseData);
                  resolved = true;
                  if (response.error) {
                    reject(new Error(response.error));
                  } else {
                    resolve(response as T);
                  }
                } catch {
                  reject(new Error("Invalid response from daemon"));
                }
              } else {
                reject(new Error("Connection closed without response"));
              }
            }
          },
          error: (socket, error) => {
            reject(error);
          },
          connectError: (socket, error) => {
            reject(new DaemonNotRunningError());
          },
        },
      });
    });
  }

  /**
   * Execute a command via the daemon
   */
  async execute(
    command: string,
    cwd?: string,
    timeout: number = 300
  ): Promise<CommandResult> {
    return this.sendRequest<CommandResult>({
      action: "exec",
      command,
      cwd,
      timeout,
    });
  }

  /**
   * List secret names
   */
  async listSecrets(): Promise<string[]> {
    const response = await this.sendRequest<ListResponse>({ action: "list" });
    return response.secrets;
  }

  /**
   * Ping the daemon to check if it's running
   */
  async ping(): Promise<PingResponse> {
    return this.sendRequest<PingResponse>({ action: "ping" });
  }

  /**
   * Request daemon shutdown
   */
  async shutdown(): Promise<void> {
    try {
      await this.sendRequest<any>({ action: "shutdown" });
    } catch {
      // Ignore errors - daemon may have already stopped
    }
  }
}
