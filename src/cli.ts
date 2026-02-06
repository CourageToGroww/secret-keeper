import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import * as readline from "readline";
import { SecretDatabase, findVaultPath } from "./database";
import { generateMasterKey, secureDelete } from "./crypto";
import { SecretKeeperDaemon, DaemonClient } from "./daemon";
import { RotationManager } from "./rotation";
import { launchTUI } from "./tui";
import { ProviderType, CustomConfig, OpenAIConfig, AWSConfig, GitHubConfig, ProviderConfig } from "./types";
import { ExportFormat, LOCAL_DB_DIR, getProjectSocketPath, findProjectSocketPath, DEFAULT_SOCKET_PATH } from "./types";

// ============================================================================
// Console Utilities
// ============================================================================

const log = {
  success: (msg: string) => console.log(chalk.green(msg)),
  error: (msg: string) => console.error(chalk.red(msg)),
  warning: (msg: string) => console.log(chalk.yellow(msg)),
  info: (msg: string) => console.log(chalk.blue(msg)),
  dim: (msg: string) => console.log(chalk.dim(msg)),
};

function table(
  data: Array<Record<string, any>>,
  columns: Array<{ key: string; header: string; width?: number }>
): void {
  // Print header
  const header = columns
    .map((c) => c.header.padEnd(c.width || 20))
    .join(" | ");
  console.log(chalk.bold(header));
  console.log("-".repeat(header.length));

  // Print rows
  for (const row of data) {
    const line = columns
      .map((c) => String(row[c.key] || "").padEnd(c.width || 20))
      .join(" | ");
    console.log(line);
  }
}

// ============================================================================
// Password Prompt
// ============================================================================

async function getPassword(prompt: string = "Password: "): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let password = "";
    
    // Save terminal state and disable echo
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onData = (char: Buffer) => {
      const c = char.toString();

      if (c === "\n" || c === "\r" || c === "\u0004") {
        cleanup();
        process.stdout.write("\n");
        resolve(password);
      } else if (c === "\u0003") {
        // Ctrl+C
        cleanup();
        process.stdout.write("\n");
        process.exit(1);
      } else if (c === "\u007F" || c === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (c.charCodeAt(0) >= 32) {
        // Only accept printable characters
        password += c;
        process.stdout.write("*");
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    process.stdin.on("data", onData);
  });
}

async function getPasswordWithConfirm(prompt: string = "Password: "): Promise<string> {
  const password = await getPassword(prompt);
  const confirm = await getPassword("Confirm password: ");

  if (password !== confirm) {
    log.error("Passwords do not match.");
    process.exit(1);
  }

  return password;
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Check if Claude Code MCP is configured and prompt to add it if not.
 */
async function promptMcpSetup(): Promise<void> {
  // Check if claude CLI is available
  try {
    const which = Bun.spawnSync(["which", "claude"]);
    if (which.exitCode !== 0) return; // Claude Code not installed, skip
  } catch {
    return;
  }

  // Resolve the MCP server command path
  const skDir = resolve(__dirname, "..");
  const indexPath = resolve(skDir, "src/index.ts");
  const bunPath = join(process.env.HOME || "", ".bun/bin/bun");

  // Check if already configured (user-level or project-level)
  const userMcpPath = join(process.env.HOME || "", ".claude.json");
  const projectMcpPath = join(process.cwd(), ".mcp.json");

  let alreadyConfigured = false;
  for (const configPath of [userMcpPath, projectMcpPath]) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        if (content.includes("secret-keeper")) {
          alreadyConfigured = true;
          break;
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  if (alreadyConfigured) return;

  console.log();
  log.info("Claude Code MCP integration not configured.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `Add secret-keeper MCP server?\n` +
      `  ${chalk.bold("1)")} Globally (all projects)\n` +
      `  ${chalk.bold("2)")} This project only\n` +
      `  ${chalk.bold("3)")} Skip\n` +
      `Choice [1/2/3]: `,
      (ans) => {
        rl.close();
        resolve(ans.trim());
      }
    );
  });

  if (answer === "1" || answer === "2") {
    const scope = answer === "1" ? "user" : "project";
    const proc = Bun.spawnSync([
      "claude", "mcp", "add",
      "--scope", scope,
      "secret-keeper",
      bunPath, "--",
      "run", indexPath, "mcp",
    ]);

    if (proc.exitCode === 0) {
      const scopeLabel = scope === "user" ? "globally" : "for this project";
      log.success(`MCP server added ${scopeLabel}. Restart Claude Code to activate.`);
    } else {
      const stderr = proc.stderr.toString().trim();
      log.error(`Failed to add MCP server: ${stderr || "unknown error"}`);
      log.dim(`You can add it manually: claude mcp add --scope ${scope} secret-keeper ${bunPath} -- run ${indexPath} mcp`);
    }
  } else {
    log.dim("Skipped. You can add it later with:");
    log.dim(`  claude mcp add --scope user secret-keeper ${bunPath} -- run ${indexPath} mcp`);
  }
}

/**
 * Get password from env var, keyfile, or prompt.
 * Automatically checks keyfile locations based on vault type.
 */
async function getPasswordAuto(db: SecretDatabase): Promise<string> {
  // 1. Check environment variable
  if (process.env.SECRET_KEEPER_PASSWORD) {
    return process.env.SECRET_KEEPER_PASSWORD;
  }

  // 2. Check keyfile based on vault location
  const vaultDir = db.isLocal()
    ? join(process.cwd(), LOCAL_DB_DIR)
    : join(process.env.HOME || "", ".secret-keeper");
  const keyFilePath = join(vaultDir, ".keyfile");

  if (existsSync(keyFilePath)) {
    return readFileSync(keyFilePath, "utf-8").trim();
  }

  // 3. Fall back to prompt
  return getPassword("Master password: ");
}

// ============================================================================
// CLI Program
// ============================================================================

export const program = new Command()
  .name("secret-keeper")
  .description("Secure secret management for Claude Code and AI assistants")
  .version("1.0.0");

// ============================================================================
// init - Initialize a new vault
// ============================================================================

program
  .command("init")
  .description("Initialize a new secret vault")
  .option("-l, --local", "Initialize a project-local vault")
  .option("-g, --generate-key", "Generate a random master key")
  .action(async (options) => {
    const db = new SecretDatabase(undefined, options.local);

    if (db.isInitialized()) {
      log.error(`Vault already exists at ${db.getPath()}`);
      process.exit(1);
    }

    let password: string;

    if (options.generateKey) {
      password = generateMasterKey();
      log.warning("Generated master key (SAVE THIS - it will not be shown again):");
      console.log(chalk.bold.cyan(password));
      console.log();

      const confirmed = await confirm("Have you saved this key?");
      if (!confirmed) {
        log.error("Aborted. Please save the key before continuing.");
        process.exit(1);
      }
    } else {
      password = await getPasswordWithConfirm("Master password: ");

      if (password.length < 8) {
        log.error("Password must be at least 8 characters.");
        process.exit(1);
      }
    }

    await db.initialize(password);
    log.success(`Vault initialized at ${db.getPath()}`);

    // Create .gitignore for local vaults
    if (options.local) {
      const gitignorePath = join(dirname(db.getPath()), ".gitignore");
      writeFileSync(gitignorePath, "*\n");
      log.dim("Created .gitignore to protect vault");
    }
  });

// ============================================================================
// add - Import secrets from .env file
// ============================================================================

program
  .command("add")
  .description("Import secrets from a .env file")
  .argument("[env-file]", "Path to .env file", ".env")
  .option("-d, --delete", "Delete .env file after import", true)
  .option("-D, --no-delete", "Keep .env file after import")
  .option("-s, --secure-delete", "Securely overwrite file before deletion")
  .option("-S, --secrets-only", "Only import values that look like secrets (KEY, SECRET, TOKEN, etc.)")
  .action(async (envFile, options) => {
    if (!existsSync(envFile)) {
      log.error(`File not found: ${envFile}`);
      process.exit(1);
    }

    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized. Run 'secret-keeper init' first.");
      process.exit(1);
    }

    const password = await getPasswordAuto(db);
    await db.unlock(password);

    const content = readFileSync(envFile, "utf-8");
    const secretsOnly = options.secretsOnly ?? false;
    const result = await db.importFromEnv(content, { secretsOnly });
    const total = result.secrets.length + result.credentials.length;

    if (total > 0) {
      log.success(`Imported ${total} entries from ${envFile}:`);
      if (result.secrets.length > 0) {
        log.info(`  Secrets (encrypted): ${result.secrets.join(", ")}`);
      }
      if (result.credentials.length > 0) {
        log.dim(`  Credentials (visible): ${result.credentials.join(", ")}`);
      }
    } else {
      log.warning("No entries found to import.");
    }

    if (result.skipped.length > 0) {
      log.dim(`Skipped ${result.skipped.length} non-secret(s): ${result.skipped.join(", ")}`);
    }

    if (options.delete) {
      if (options.secureDelete) {
        await secureDelete(envFile);
        log.dim("Securely deleted .env file");
      } else {
        const fs = await import("fs/promises");
        await fs.unlink(envFile);
        log.dim("Deleted .env file");
      }
    }

    db.close();
  });

// ============================================================================
// set - Set a single secret
// ============================================================================

program
  .command("set")
  .description("Set a single secret")
  .argument("<name>", "Name of the secret")
  .option("-v, --value <value>", "Secret value (will prompt if not provided)")
  .option("-d, --description <desc>", "Description of the secret")
  .action(async (name, options) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized. Run 'secret-keeper init' first.");
      process.exit(1);
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    const value = options.value || (await getPassword("Secret value: "));
    await db.addSecret(name, value, { description: options.description });

    log.success(`Secret '${name}' saved.`);
    db.close();
  });

// ============================================================================
// list - List stored secrets
// ============================================================================

program
  .command("list")
  .description("List all stored secrets (names only)")
  .action(async () => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized. Run 'secret-keeper init' first.");
      process.exit(1);
    }

    const secrets = db.listSecrets();

    if (secrets.length === 0) {
      log.info("No secrets stored.");
      return;
    }

    table(
      secrets.map((s) => ({
        name: s.name,
        description: s.description || "",
        updated: s.updatedAt.split("T")[0],
      })),
      [
        { key: "name", header: "Name", width: 30 },
        { key: "description", header: "Description", width: 40 },
        { key: "updated", header: "Updated", width: 12 },
      ]
    );

    console.log();
    log.dim(`Total: ${secrets.length} secret(s)`);
  });

// ============================================================================
// delete - Delete a secret
// ============================================================================

program
  .command("delete")
  .description("Delete a secret")
  .argument("<name>", "Name of the secret to delete")
  .option("-y, --confirm", "Skip confirmation prompt")
  .action(async (name, options) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    if (!options.confirm) {
      const confirmed = await confirm(`Delete secret '${name}'?`);
      if (!confirmed) {
        log.info("Aborted.");
        return;
      }
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);
    await db.deleteSecret(name);

    log.success(`Secret '${name}' deleted.`);
    db.close();
  });

// ============================================================================
// run - Execute command with secrets (direct, no daemon)
// ============================================================================

program
  .command("run")
  .description("Run a command with secrets injected as environment variables")
  .argument("<command...>", "Command to execute")
  .option("-n, --names <names>", "Comma-separated list of secrets to inject")
  .action(async (commandParts, options) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    let secrets = await db.getAllSecrets();

    // Filter secrets if names specified
    if (options.names) {
      const names = options.names.split(",").map((n: string) => n.trim());
      secrets = Object.fromEntries(
        Object.entries(secrets).filter(([name]) => names.includes(name))
      );
    }

    const command = commandParts.join(" ");
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: process.cwd(),
      env: { ...process.env, ...secrets },
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await proc.exited;
    db.close();
    process.exit(exitCode ?? 0);
  });

// ============================================================================
// export - Export secrets
// ============================================================================

program
  .command("export")
  .description("Export secrets (WARNING: shows actual values)")
  .option("-f, --format <format>", "Output format: shell, docker, json", "shell")
  .option("-n, --names <names>", "Comma-separated list of secrets to export")
  .action(async (options) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    let secrets = await db.getAllSecrets();

    // Filter secrets if names specified
    if (options.names) {
      const names = options.names.split(",").map((n: string) => n.trim());
      secrets = Object.fromEntries(
        Object.entries(secrets).filter(([name]) => names.includes(name))
      );
    }

    const format = options.format as ExportFormat;

    switch (format) {
      case "shell":
        for (const [name, value] of Object.entries(secrets)) {
          const escaped = value.replace(/'/g, "'\\''");
          console.log(`export ${name}='${escaped}'`);
        }
        break;

      case "docker":
        for (const [name, value] of Object.entries(secrets)) {
          console.log(`-e ${name}=${value}`);
        }
        break;

      case "json":
        console.log(JSON.stringify(secrets, null, 2));
        break;

      default:
        log.error(`Unknown format: ${format}`);
        process.exit(1);
    }

    db.close();
  });

// ============================================================================
// audit - Show audit log
// ============================================================================

program
  .command("audit")
  .description("Show vault audit log")
  .action(async () => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const entries = db.getAuditLog(50);

    if (entries.length === 0) {
      log.info("No audit entries.");
      return;
    }

    table(
      entries.map((e) => ({
        timestamp: e.timestamp.replace("T", " ").split(".")[0],
        action: e.action,
        secret: e.secretName || "",
        details: e.details || "",
      })),
      [
        { key: "timestamp", header: "Timestamp", width: 20 },
        { key: "action", header: "Action", width: 20 },
        { key: "secret", header: "Secret", width: 20 },
        { key: "details", header: "Details", width: 30 },
      ]
    );
  });

// ============================================================================
// change-password - Change master password
// ============================================================================

program
  .command("change-password")
  .description("Change the master password")
  .action(async () => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const currentPassword = await getPassword("Current password: ");
    const newPassword = await getPasswordWithConfirm("New password: ");

    if (newPassword.length < 8) {
      log.error("Password must be at least 8 characters.");
      process.exit(1);
    }

    await db.changePassword(currentPassword, newPassword);
    log.success("Password changed successfully.");
    db.close();
  });

// ============================================================================
// install - Install into a project
// ============================================================================

program
  .command("install")
  .description("Install Secret Keeper into a project with automatic daemon startup")
  .argument("[project-path]", "Path to project directory", ".")
  .option("--direnv", "Create .envrc for direnv integration")
  .option("--shell", "Show shell integration instructions")
  .action(async (projectPath, options) => {
    const fullPath = projectPath === "." ? process.cwd() : resolve(process.cwd(), projectPath);

    // Create .secret-keeper directory
    const skDir = join(fullPath, LOCAL_DB_DIR);
    if (!existsSync(skDir)) {
      mkdirSync(skDir, { mode: 0o700, recursive: true });
    }

    // Create .gitignore
    const gitignorePath = join(skDir, ".gitignore");
    writeFileSync(gitignorePath, "*\n");

    log.success("Secret Keeper installed!");

    // Direnv integration
    if (options.direnv) {
      const envrcPath = join(fullPath, ".envrc");
      const bunPath = join(process.env.HOME || "", ".bun/bin/bun");
      const skPath = resolve(__dirname, "../src/index.ts");

      const envrcContent = `# Secret Keeper - Auto-start daemon when entering directory
# Requires: direnv (https://direnv.net)

# Start daemon if vault exists and daemon not running
if [ -d ".secret-keeper" ]; then
  ${bunPath} run ${skPath} auto --local --quiet 2>/dev/null || true
fi
`;

      if (existsSync(envrcPath)) {
        const existing = readFileSync(envrcPath, "utf-8");
        if (!existing.includes("Secret Keeper")) {
          writeFileSync(envrcPath, existing + "\n" + envrcContent);
          log.success("Added to existing .envrc");
        } else {
          log.dim(".envrc already has Secret Keeper integration");
        }
      } else {
        writeFileSync(envrcPath, envrcContent);
        log.success("Created .envrc for direnv integration");
      }

      log.dim("Run 'direnv allow' to enable automatic daemon startup");
    }

    // Shell integration instructions
    if (options.shell) {
      console.log();
      log.info("Shell Integration Options:");
      console.log();

      const bunPath = join(process.env.HOME || "", ".bun/bin/bun");
      const skPath = resolve(__dirname, "../src/index.ts");

      console.log(chalk.bold("Option 1: Add to shell config (~/.bashrc or ~/.zshrc):"));
      console.log(chalk.dim(`
# Secret Keeper - Auto-start daemon when entering a project
sk_auto() {
  if [ -d ".secret-keeper" ]; then
    ${bunPath} run ${skPath} auto --local --quiet 2>/dev/null || true
  fi
}

# Hook into cd command
cd() {
  builtin cd "$@" && sk_auto
}

# Run on shell startup too
sk_auto
`));

      console.log(chalk.bold("Option 2: Use direnv (recommended):"));
      console.log(chalk.dim(`
  secret-keeper install --direnv
  direnv allow
`));

      console.log(chalk.bold("Option 3: Manual startup:"));
      console.log(chalk.dim(`
  secret-keeper auto  # Initialize vault + start daemon
`));
    }

    console.log();
    log.info("Next steps:");
    log.dim("  1. secret-keeper auto         # Initialize vault and start daemon");
    log.dim("  2. secret-keeper add .env     # Import your secrets");
    log.dim("  3. secret-keeper exec <cmd>   # Run commands with secrets");
    console.log();
    log.dim("For automatic startup, run: secret-keeper install --shell");
    log.dim("Then add the snippet to your ~/.zshrc or ~/.bashrc");
  });

// ============================================================================
// info - Show vault information
// ============================================================================

program
  .command("info")
  .description("Show vault information")
  .action(async () => {
    const vaultPath = findVaultPath();

    if (!vaultPath) {
      log.warning("No vault found.");
      log.dim("Run 'secret-keeper init' to create one.");
      return;
    }

    const db = new SecretDatabase();
    const isLocal = db.isLocal();
    const count = db.getSecretCount();

    console.log(chalk.bold("Vault Information"));
    console.log("-".repeat(40));
    console.log(`Location: ${vaultPath}`);
    console.log(`Type: ${isLocal ? "Project-local" : "Global"}`);
    console.log(`Secrets: ${count}`);
  });

// ============================================================================
// daemon - Start the daemon
// ============================================================================

program
  .command("daemon")
  .description("Start the secure daemon")
  .option("-f, --foreground", "Run in foreground")
  .option("-p, --project <path>", "Project directory (auto-detects local vault)")
  .option("-g, --global", "Force global daemon (ignore local vault)")
  .option("--no-rotation", "Disable automatic rotation")
  .option("--rotation-interval <minutes>", "Rotation check interval in minutes", "60")
  .action(async (options) => {
    // Determine the project path for socket naming
    const projectPath = options.project || process.cwd();

    // Check for local vault unless forced global
    let db: SecretDatabase;
    let socketPath: string;

    if (options.global) {
      db = new SecretDatabase();
      socketPath = DEFAULT_SOCKET_PATH;
    } else {
      // Try local vault first
      db = new SecretDatabase(undefined, true); // Try local
      if (db.isInitialized()) {
        socketPath = getProjectSocketPath(projectPath);
        log.dim(`Using project-local vault at ${db.getPath()}`);
      } else {
        // Fall back to global
        db = new SecretDatabase();
        socketPath = DEFAULT_SOCKET_PATH;
      }
    }

    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    const daemon = new SecretKeeperDaemon(socketPath);
    await daemon.loadSecrets(db);

    log.success(`Daemon started with ${daemon.getSecretCount()} secret(s)`);
    log.dim(`Socket: ${socketPath}`);

    // Start rotation scheduler unless disabled
    if (options.rotation !== false) {
      const intervalMs = parseInt(options.rotationInterval, 10) * 60 * 1000;
      daemon.startScheduler(intervalMs);
      log.dim(`Rotation scheduler active (checking every ${options.rotationInterval} min)`);
    }

    log.dim("Press Ctrl+C to stop");
    console.log();

    daemon.start();

    // Keep process running
    await new Promise(() => {});
  });

// ============================================================================
// exec - Execute command via daemon (for Claude)
// ============================================================================

program
  .command("exec")
  .description("Execute a command via the secure daemon")
  .argument("<command...>", "Command to execute")
  .option("-t, --timeout <seconds>", "Command timeout", "300")
  .option("-g, --global", "Use global daemon")
  .action(async (commandParts, options) => {
    // Auto-detect project socket unless --global specified
    const socketPath = options.global ? DEFAULT_SOCKET_PATH : findProjectSocketPath();
    const client = new DaemonClient(socketPath);

    if (!client.isRunning()) {
      const isProject = socketPath !== DEFAULT_SOCKET_PATH;
      log.error(`Daemon not running${isProject ? " (project)" : ""}. Start it with 'secret-keeper daemon'.`);
      process.exit(1);
    }

    const command = commandParts.join(" ");
    const timeout = parseInt(options.timeout, 10);

    try {
      const result = await client.execute(command, process.cwd(), timeout);

      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }

      process.exit(result.exitCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(message);
      process.exit(1);
    }
  });

// ============================================================================
// status - Check daemon status
// ============================================================================

program
  .command("status")
  .description("Check daemon status")
  .option("-g, --global", "Check global daemon only")
  .option("-a, --all", "Check all running daemons")
  .action(async (options) => {
    if (options.all) {
      // Check both global and project daemons
      const sockets: Array<{ name: string; path: string }> = [];

      // Check global daemon
      const globalClient = new DaemonClient(DEFAULT_SOCKET_PATH);
      if (globalClient.isRunning()) {
        sockets.push({ name: "Global", path: DEFAULT_SOCKET_PATH });
      }

      // Check project daemon for current directory
      const projectPath = getProjectSocketPath(process.cwd());
      if (projectPath !== DEFAULT_SOCKET_PATH) {
        const projectClient = new DaemonClient(projectPath);
        if (projectClient.isRunning()) {
          sockets.push({ name: `Project (${process.cwd()})`, path: projectPath });
        }
      }

      if (sockets.length === 0) {
        log.warning("No daemons running.");
        process.exit(1);
      }

      for (const sock of sockets) {
        const client = new DaemonClient(sock.path);
        try {
          const response = await client.ping();
          log.success(`${sock.name} daemon is running`);
          log.dim(`  Socket: ${sock.path}`);
          log.dim(`  Secrets loaded: ${response.secretsLoaded}`);
        } catch {
          log.warning(`${sock.name} daemon not responding`);
        }
      }
      return;
    }

    // Normal single-daemon check
    const socketPath = options.global ? DEFAULT_SOCKET_PATH : findProjectSocketPath();
    const client = new DaemonClient(socketPath);
    const isProject = socketPath !== DEFAULT_SOCKET_PATH;

    if (!client.isRunning()) {
      log.warning(`Daemon not running${isProject ? " (project)" : ""}.`);
      log.dim("Start it with 'secret-keeper daemon'");
      process.exit(1);
    }

    try {
      const response = await client.ping();
      log.success(`Daemon is running${isProject ? " (project)" : " (global)"}`);
      log.dim(`Socket: ${socketPath}`);
      log.dim(`Secrets loaded: ${response.secretsLoaded}`);

      const secrets = await client.listSecrets();
      if (secrets.length > 0) {
        log.dim(`Available: ${secrets.join(", ")}`);
      }
    } catch (error) {
      log.error("Failed to connect to daemon.");
      process.exit(1);
    }
  });

// ============================================================================
// stop - Stop the daemon
// ============================================================================

program
  .command("stop")
  .description("Stop the daemon")
  .option("-g, --global", "Stop global daemon only")
  .option("-a, --all", "Stop all running daemons")
  .action(async (options) => {
    if (options.all) {
      // Stop all daemons we know about
      let stopped = 0;

      // Try global daemon
      const globalClient = new DaemonClient(DEFAULT_SOCKET_PATH);
      if (globalClient.isRunning()) {
        try {
          await globalClient.shutdown();
          log.success("Global daemon stopped.");
          stopped++;
        } catch {
          log.success("Global daemon stopped.");
          stopped++;
        }
      }

      // Try project daemon
      const projectPath = getProjectSocketPath(process.cwd());
      if (projectPath !== DEFAULT_SOCKET_PATH) {
        const projectClient = new DaemonClient(projectPath);
        if (projectClient.isRunning()) {
          try {
            await projectClient.shutdown();
            log.success("Project daemon stopped.");
            stopped++;
          } catch {
            log.success("Project daemon stopped.");
            stopped++;
          }
        }
      }

      if (stopped === 0) {
        log.warning("No daemons were running.");
      }
      return;
    }

    const socketPath = options.global ? DEFAULT_SOCKET_PATH : findProjectSocketPath();
    const client = new DaemonClient(socketPath);
    const isProject = socketPath !== DEFAULT_SOCKET_PATH;

    if (!client.isRunning()) {
      log.warning(`Daemon not running${isProject ? " (project)" : ""}.`);
      return;
    }

    try {
      await client.shutdown();
      log.success(`Daemon stopped${isProject ? " (project)" : " (global)"}.`);
    } catch {
      // Daemon may have already stopped
      log.success(`Daemon stopped${isProject ? " (project)" : " (global)"}.`);
    }
  });

// ============================================================================
// tui - Launch interactive TUI
// ============================================================================

program
  .command("tui")
  .description("Launch interactive TUI")
  .action(async () => {
    const db = new SecretDatabase();

    // Try to get password from env or keyfile (no prompt)
    let password: string | null = null;

    if (process.env.SECRET_KEEPER_PASSWORD) {
      password = process.env.SECRET_KEEPER_PASSWORD;
    } else {
      // Try to load from keyfile
      const vaultDir = db.isLocal()
        ? join(process.cwd(), LOCAL_DB_DIR)
        : join(process.env.HOME || "", ".secret-keeper");
      const keyFilePath = join(vaultDir, ".keyfile");

      if (existsSync(keyFilePath)) {
        password = readFileSync(keyFilePath, "utf-8").trim();
      }
    }

    // If we have a password and vault is initialized, unlock
    if (password && db.isInitialized()) {
      try {
        await db.unlock(password);
      } catch {
        // Invalid password, will prompt in TUI if needed
        password = null;
      }
    }

    // Completely reset stdin state before launching TUI
    process.stdin.removeAllListeners();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    // Drain any buffered input
    process.stdin.read();

    // Create fresh stdin state
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    await launchTUI(db, password);
    db.close();
  });

// ============================================================================
// rotation - Rotation management commands
// ============================================================================

const rotationCommand = program
  .command("rotation")
  .description("Manage secret rotation");

// rotation list
rotationCommand
  .command("list")
  .description("List rotation configurations")
  .action(async () => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    const manager = new RotationManager(db);
    const configs = manager.listRotationConfigs();

    if (configs.length === 0) {
      log.info("No rotation configurations found.");
      db.close();
      return;
    }

    table(
      configs.map((c) => ({
        secret: c.secretName,
        provider: c.providerType,
        days: c.scheduleDays,
        enabled: c.enabled ? "Yes" : "No",
        next: c.nextRotation ? c.nextRotation.split("T")[0] : "Never",
      })),
      [
        { key: "secret", header: "Secret", width: 25 },
        { key: "provider", header: "Provider", width: 12 },
        { key: "days", header: "Days", width: 6 },
        { key: "enabled", header: "Enabled", width: 8 },
        { key: "next", header: "Next Rotation", width: 12 },
      ]
    );

    db.close();
  });

// rotation configure
rotationCommand
  .command("configure")
  .description("Configure rotation for a secret")
  .argument("<secret>", "Name of the secret")
  .argument("<provider>", "Provider type: custom, openai, aws, github")
  .option("-d, --days <days>", "Rotation interval in days", "30")
  .option("-c, --command <command>", "Rotate command (for custom provider)")
  .option("--access-key-id <name>", "Access key ID secret name (for AWS)")
  .action(async (secretName, provider, options) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    // Validate provider type
    const validProviders: ProviderType[] = ["custom", "openai", "aws", "github"];
    if (!validProviders.includes(provider)) {
      log.error(`Invalid provider: ${provider}. Valid options: ${validProviders.join(", ")}`);
      process.exit(1);
    }

    // Build provider config
    let providerConfig: ProviderConfig;
    switch (provider as ProviderType) {
      case "custom":
        if (!options.command) {
          log.error("Custom provider requires --command option");
          process.exit(1);
        }
        providerConfig = {
          type: "custom",
          rotateCommand: options.command,
        };
        break;
      case "openai":
        providerConfig = {
          type: "openai",
          apiKeyName: secretName,
        };
        break;
      case "aws":
        if (!options.accessKeyId) {
          log.error("AWS provider requires --access-key-id option");
          process.exit(1);
        }
        providerConfig = {
          type: "aws",
          accessKeyIdName: options.accessKeyId,
          secretAccessKeyName: secretName,
        };
        break;
      case "github":
        providerConfig = {
          type: "github",
          tokenName: secretName,
          scopes: [],
        };
        break;
    }

    const manager = new RotationManager(db);
    await manager.configureRotation(
      secretName,
      provider as ProviderType,
      parseInt(options.days, 10),
      providerConfig
    );

    log.success(`Rotation configured for '${secretName}' (${provider}, every ${options.days} days)`);
    db.close();
  });

// rotation enable
rotationCommand
  .command("enable")
  .description("Enable rotation for a secret")
  .argument("<secret>", "Name of the secret")
  .action(async (secretName) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    const manager = new RotationManager(db);
    manager.enableRotation(secretName);

    log.success(`Rotation enabled for '${secretName}'`);
    db.close();
  });

// rotation disable
rotationCommand
  .command("disable")
  .description("Disable rotation for a secret")
  .argument("<secret>", "Name of the secret")
  .action(async (secretName) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    const manager = new RotationManager(db);
    manager.disableRotation(secretName);

    log.success(`Rotation disabled for '${secretName}'`);
    db.close();
  });

// rotation now
rotationCommand
  .command("now")
  .description("Rotate a secret immediately")
  .argument("<secret>", "Name of the secret")
  .action(async (secretName) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    const manager = new RotationManager(db);
    
    log.info(`Rotating '${secretName}'...`);
    const result = await manager.rotateNow(secretName);

    if (result.success) {
      log.success(`Rotation successful for '${secretName}'`);
    } else {
      log.error(`Rotation failed: ${result.error}`);
      process.exit(1);
    }

    db.close();
  });

// rotation test
rotationCommand
  .command("test")
  .description("Test rotation configuration (dry run)")
  .argument("<secret>", "Name of the secret")
  .action(async (secretName) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    const manager = new RotationManager(db);
    
    log.info(`Testing rotation for '${secretName}'...`);
    const result = await manager.testRotation(secretName);

    if (result.success) {
      log.success("Test passed!");
    } else {
      log.error(`Test failed: ${result.error}`);
      process.exit(1);
    }

    db.close();
  });

// rotation history
rotationCommand
  .command("history")
  .description("Show rotation history")
  .argument("[secret]", "Optional: filter by secret name")
  .option("-n, --limit <limit>", "Maximum entries to show", "20")
  .action(async (secretName, options) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    // History doesn't require unlocked vault for viewing
    db.migrateRotationTables();

    const manager = new RotationManager(db);
    const history = manager.getHistory(secretName, parseInt(options.limit, 10));

    if (history.length === 0) {
      log.info("No rotation history found.");
      return;
    }

    table(
      history.map((h) => ({
        timestamp: h.timestamp.replace("T", " ").split(".")[0],
        secret: h.secretName,
        provider: h.providerType,
        status: h.status === "success" ? "✓ Success" : "✗ Failed",
        error: h.errorMessage ? h.errorMessage.substring(0, 30) + "..." : "",
      })),
      [
        { key: "timestamp", header: "Timestamp", width: 20 },
        { key: "secret", header: "Secret", width: 20 },
        { key: "provider", header: "Provider", width: 10 },
        { key: "status", header: "Status", width: 12 },
        { key: "error", header: "Error", width: 35 },
      ]
    );
  });

// rotation delete
rotationCommand
  .command("delete")
  .description("Delete rotation configuration")
  .argument("<secret>", "Name of the secret")
  .option("-y, --confirm", "Skip confirmation prompt")
  .action(async (secretName, options) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    if (!options.confirm) {
      const confirmed = await confirm(`Delete rotation config for '${secretName}'?`);
      if (!confirmed) {
        log.info("Aborted.");
        return;
      }
    }

    const password =
      await getPasswordAuto(db);
    await db.unlock(password);

    const manager = new RotationManager(db);
    manager.deleteRotationConfig(secretName);

    log.success(`Rotation configuration deleted for '${secretName}'`);
    db.close();
  });

// ============================================================================
// mcp - Start MCP server for Claude Code integration
// ============================================================================

program
  .command("mcp")
  .description("Start MCP server for Claude Code integration (requires daemon running)")
  .action(async () => {
    // MCP server runs via stdio - just import and run
    await import("./mcp");
  });

// ============================================================================
// auto - Automatic setup and daemon start for Claude Code integration
// ============================================================================

const KEY_FILE_NAME = ".keyfile";

program
  .command("auto")
  .description("Automatically initialize vault and start daemon (for Claude Code hooks)")
  .option("-l, --local", "Use project-local vault (recommended)")
  .option("-q, --quiet", "Suppress output except errors")
  .action(async (options) => {
    const quiet = options.quiet;
    const useLocal = options.local ?? true; // Default to local vault

    const logQuiet = {
      success: (msg: string) => !quiet && log.success(msg),
      info: (msg: string) => !quiet && log.info(msg),
      dim: (msg: string) => !quiet && log.dim(msg),
      warning: (msg: string) => !quiet && log.warning(msg),
      error: (msg: string) => log.error(msg), // Always show errors
    };

    try {
      // Determine vault directory
      const vaultDir = useLocal
        ? join(process.cwd(), LOCAL_DB_DIR)
        : join(process.env.HOME || "", ".secret-keeper");

      const keyFilePath = join(vaultDir, KEY_FILE_NAME);

      // Step 1: Check if vault is initialized
      let db = new SecretDatabase(undefined, useLocal);
      let password: string;

      if (!db.isInitialized()) {
        logQuiet.info("Initializing new vault...");

        // Generate a secure key
        password = generateMasterKey();

        // Create vault directory with secure permissions
        if (!existsSync(vaultDir)) {
          mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
        }

        // Initialize the vault
        await db.initialize(password);

        // Save the key to a secure file
        writeFileSync(keyFilePath, password, { mode: 0o600 });

        // Create .gitignore for local vaults
        if (useLocal) {
          const gitignorePath = join(vaultDir, ".gitignore");
          writeFileSync(gitignorePath, "*\n");
        }

        logQuiet.success(`Vault initialized at ${db.getPath()}`);
        logQuiet.dim(`Key saved to ${keyFilePath}`);

        // Always show the generated key so user can back it up
        console.log();
        log.warning("YOUR MASTER KEY (save this somewhere safe!):");
        console.log(chalk.bold.yellow(`  ${password}`));
        console.log();
        log.dim("This key is also saved in: " + keyFilePath);
      } else {
        logQuiet.info("Vault already initialized.");

        // Load key from keyfile or environment
        if (process.env.SECRET_KEEPER_PASSWORD) {
          password = process.env.SECRET_KEEPER_PASSWORD;
        } else if (existsSync(keyFilePath)) {
          password = readFileSync(keyFilePath, "utf-8").trim();
        } else {
          // No keyfile and no env var - can't auto-start
          // In quiet mode, silently exit (vault was set up with manual password)
          if (quiet) {
            process.exit(0);
          }
          log.error("No keyfile found and SECRET_KEEPER_PASSWORD not set.");
          log.dim(`Expected keyfile at: ${keyFilePath}`);
          log.dim("This vault was created with a manual password.");
          log.dim("Either set SECRET_KEEPER_PASSWORD or start daemon manually: sk daemon");
          process.exit(1);
        }

        await db.unlock(password);
      }

      // Step 2: Auto-import .env files if present
      const envFiles = [".env"];
      for (const envFile of envFiles) {
        const envPath = join(process.cwd(), envFile);
        if (existsSync(envPath)) {
          const content = readFileSync(envPath, "utf-8");
          const result = await db.importFromEnv(content);
          const total = result.secrets.length + result.credentials.length;

          if (total > 0) {
            logQuiet.success(`Imported ${total} entries from ${envFile}:`);
            if (result.secrets.length > 0) {
              logQuiet.info(`  Secrets (encrypted): ${result.secrets.join(", ")}`);
            }
            if (result.credentials.length > 0) {
              logQuiet.dim(`  Credentials (visible): ${result.credentials.join(", ")}`);
            }

            // Delete .env after successful import
            const fs = await import("fs/promises");
            await fs.unlink(envPath);
            logQuiet.dim(`Deleted ${envFile} (now stored in vault)`);
          }
        }
      }

      // Step 3: Check if daemon is running
      const socketPath = useLocal
        ? getProjectSocketPath(process.cwd())
        : DEFAULT_SOCKET_PATH;

      const client = new DaemonClient(socketPath);

      if (client.isRunning()) {
        try {
          const ping = await client.ping();
          logQuiet.success(`Daemon already running (${ping.secretsLoaded} secrets loaded)`);
          db.close();
          return;
        } catch {
          // Socket exists but daemon not responding - remove stale socket
          logQuiet.dim("Removing stale socket...");
          try {
            const { unlinkSync } = await import("fs");
            unlinkSync(socketPath);
          } catch {
            // Ignore
          }
        }
      }

      // Step 3: Start daemon in background
      logQuiet.info("Starting daemon...");

      const cwd = process.cwd();
      // Use the secret-keeper installation path, not the current project
      const skDir = resolve(__dirname, "..");
      const indexPath = resolve(skDir, "src/index.ts");
      const bunPath = (process.env.HOME || "") + "/.bun/bin/bun";

      // Build command args
      const args = ["run", indexPath, "daemon"];
      if (useLocal) {
        args.push("--project", cwd);
      } else {
        args.push("--global");
      }

      // Create log directory
      const logDir = "/tmp/secret-keeper";
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
      }

      // Open log file
      const { openSync, closeSync } = await import("fs");
      const logPath = `${logDir}/daemon.log`;
      const outFd = openSync(logPath, "a");

      // Spawn daemon as detached background process
      const { spawn } = await import("child_process");
      const child = spawn(bunPath, args, {
        detached: true,
        stdio: ["ignore", outFd, outFd],
        cwd,
        shell: true,
        env: {
          ...process.env,
          SECRET_KEEPER_PASSWORD: password,
          HOME: process.env.HOME || "",
          PATH: process.env.PATH || "",
        },
      });

      child.unref();
      closeSync(outFd);

      // Wait briefly for daemon to start
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Verify daemon started
      if (existsSync(socketPath)) {
        try {
          const newClient = new DaemonClient(socketPath);
          const ping = await newClient.ping();
          logQuiet.success(`Daemon started (${ping.secretsLoaded} secrets loaded)`);
        } catch {
          logQuiet.success("Daemon started.");
        }
      } else {
        logQuiet.warning("Daemon may have failed to start. Check /tmp/secret-keeper/daemon.log");
      }

      // Step 4: Check if Claude Code MCP integration is configured
      if (!quiet) {
        await promptMcpSetup();
      }

      db.close();
    } catch (error) {
      log.error(`Auto setup failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ============================================================================
// reset - Reset vault and start fresh
// ============================================================================

program
  .command("reset")
  .description("Reset vault completely and start fresh")
  .option("-l, --local", "Reset project-local vault (default)")
  .option("-g, --global", "Reset global vault")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--reinit", "Reinitialize vault after reset (runs 'sk auto')")
  .action(async (options) => {
    const useLocal = options.global ? false : true;

    // Determine vault directory
    const vaultDir = useLocal
      ? join(process.cwd(), LOCAL_DB_DIR)
      : join(process.env.HOME || "", ".secret-keeper");

    // Check if vault exists
    if (!existsSync(vaultDir)) {
      log.warning("No vault found to reset.");
      if (useLocal) {
        log.dim(`Expected at: ${vaultDir}`);
        log.dim("Use --global to reset the global vault instead.");
      }
      return;
    }

    // Confirm unless --yes
    if (!options.yes) {
      const vaultType = useLocal ? "project-local" : "global";
      console.log();
      log.warning(`This will permanently delete the ${vaultType} vault at:`);
      console.log(chalk.bold(`  ${vaultDir}`));
      console.log();
      log.warning("All secrets and rotation configurations will be lost!");
      console.log();

      const confirmed = await confirm("Are you sure you want to reset?");
      if (!confirmed) {
        log.info("Aborted.");
        return;
      }
    }

    // Step 1: Stop daemon if running
    const socketPath = useLocal
      ? getProjectSocketPath(process.cwd())
      : DEFAULT_SOCKET_PATH;

    const client = new DaemonClient(socketPath);
    if (client.isRunning()) {
      log.dim("Stopping daemon...");
      try {
        await client.shutdown();
      } catch {
        // Ignore errors
      }
      // Wait for daemon to stop
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Remove stale socket if it exists
    if (existsSync(socketPath)) {
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(socketPath);
      } catch {
        // Ignore
      }
    }

    // Step 2: Remove vault directory
    log.dim("Removing vault...");
    const { rmSync } = await import("fs");
    try {
      rmSync(vaultDir, { recursive: true, force: true });
      log.success("Vault removed.");
    } catch (error) {
      log.error(`Failed to remove vault: ${error}`);
      process.exit(1);
    }

    // Step 3: Optionally reinitialize
    if (options.reinit) {
      console.log();
      log.info("Reinitializing vault...");

      // Generate a new key and initialize
      const password = generateMasterKey();

      // Create vault directory
      mkdirSync(vaultDir, { recursive: true, mode: 0o700 });

      // Initialize vault
      const db = new SecretDatabase(undefined, useLocal);
      await db.initialize(password);

      // Save keyfile
      const keyFilePath = join(vaultDir, KEY_FILE_NAME);
      writeFileSync(keyFilePath, password, { mode: 0o600 });

      // Create .gitignore for local vaults
      if (useLocal) {
        const gitignorePath = join(vaultDir, ".gitignore");
        writeFileSync(gitignorePath, "*\n");
      }

      log.success(`Vault reinitialized at ${vaultDir}`);

      // Show the new key
      console.log();
      log.warning("YOUR NEW MASTER KEY (save this somewhere safe!):");
      console.log(chalk.bold.yellow(`  ${password}`));
      console.log();
      log.dim("This key is also saved in: " + keyFilePath);

      // Start daemon
      console.log();
      log.info("Starting daemon...");

      const cwd = process.cwd();
      const skDir = resolve(__dirname, "..");
      const indexPath = resolve(skDir, "src/index.ts");
      const bunPath = (process.env.HOME || "") + "/.bun/bin/bun";

      const args = ["run", indexPath, "daemon"];
      if (useLocal) {
        args.push("--project", cwd);
      } else {
        args.push("--global");
      }

      const logDir = "/tmp/secret-keeper";
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
      }

      const { openSync, closeSync, spawn } = await import("fs").then(fs => ({
        openSync: fs.openSync,
        closeSync: fs.closeSync,
        spawn: require("child_process").spawn
      }));

      const logPath = `${logDir}/daemon.log`;
      const outFd = openSync(logPath, "a");

      const { spawn: spawnFn } = await import("child_process");
      const child = spawnFn(bunPath, args, {
        detached: true,
        stdio: ["ignore", outFd, outFd],
        cwd,
        shell: true,
        env: {
          ...process.env,
          SECRET_KEEPER_PASSWORD: password,
          HOME: process.env.HOME || "",
          PATH: process.env.PATH || "",
        },
      });

      child.unref();
      closeSync(outFd);

      await new Promise((resolve) => setTimeout(resolve, 1500));

      if (existsSync(socketPath)) {
        try {
          const newClient = new DaemonClient(socketPath);
          const ping = await newClient.ping();
          log.success(`Daemon started (${ping.secretsLoaded} secrets loaded)`);
        } catch {
          log.success("Daemon started.");
        }
      } else {
        log.warning("Daemon may have failed. Check /tmp/secret-keeper/daemon.log");
      }

      db.close();
    } else {
      console.log();
      log.dim("Run 'sk auto' to reinitialize the vault.");
    }
  });
