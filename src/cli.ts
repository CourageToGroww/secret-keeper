import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import * as readline from "readline";
import { SecretDatabase, findVaultPath } from "./database";
import { generateMasterKey, secureDelete } from "./crypto";
import { SecretKeeperDaemon, DaemonClient } from "./daemon";
import { ExportFormat, LOCAL_DB_DIR } from "./types";

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
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Disable echo
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdout.write(prompt);
    let password = "";

    process.stdin.on("data", (char) => {
      const c = char.toString();

      if (c === "\n" || c === "\r" || c === "\u0004") {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdout.write("\n");
        rl.close();
        resolve(password);
      } else if (c === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (c === "\u007F" || c === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
      } else {
        password += c;
      }
    });
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

    const password =
      process.env.SECRET_KEEPER_PASSWORD || (await getPassword("Master password: "));
    await db.unlock(password);

    const content = readFileSync(envFile, "utf-8");
    const [count, names] = await db.importFromEnv(content);

    log.success(`Imported ${count} secret(s): ${names.join(", ")}`);

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
      process.env.SECRET_KEEPER_PASSWORD || (await getPassword("Master password: "));
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
      process.env.SECRET_KEEPER_PASSWORD || (await getPassword("Master password: "));
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
      process.env.SECRET_KEEPER_PASSWORD || (await getPassword("Master password: "));
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
      process.env.SECRET_KEEPER_PASSWORD || (await getPassword("Master password: "));
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
  .description("Install Secret Keeper into a project")
  .argument("[project-path]", "Path to project directory", ".")
  .action(async (projectPath) => {
    const fullPath = join(process.cwd(), projectPath);

    // Create .secret-keeper directory
    const skDir = join(fullPath, LOCAL_DB_DIR);
    if (!existsSync(skDir)) {
      mkdirSync(skDir, { mode: 0o700, recursive: true });
    }

    // Create .gitignore
    const gitignorePath = join(skDir, ".gitignore");
    writeFileSync(gitignorePath, "*\n");

    // Create or append to CLAUDE.md
    const claudeMdPath = join(fullPath, "CLAUDE.md");
    const claudeContent = `
## Secret Keeper

This project uses Secret Keeper for secure secret management.

### For Humans
\`\`\`bash
# Start the daemon (enter password once)
secret-keeper daemon
\`\`\`

### For Claude
\`\`\`bash
# Execute commands safely
sk exec npm start
sk exec ./deploy.sh

# Check daemon status
sk status
\`\`\`

All secret values are automatically scrubbed from output.
`;

    if (existsSync(claudeMdPath)) {
      const existing = readFileSync(claudeMdPath, "utf-8");
      if (!existing.includes("Secret Keeper")) {
        writeFileSync(claudeMdPath, existing + "\n" + claudeContent);
        log.dim("Appended to existing CLAUDE.md");
      }
    } else {
      writeFileSync(claudeMdPath, claudeContent);
      log.dim("Created CLAUDE.md");
    }

    log.success("Secret Keeper installed!");
    console.log();
    log.info("Next steps:");
    log.dim("  1. secret-keeper init --local");
    log.dim("  2. Create .env with your secrets");
    log.dim("  3. secret-keeper add");
    log.dim("  4. secret-keeper daemon");
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
  .action(async (options) => {
    const db = new SecretDatabase();
    if (!db.isInitialized()) {
      log.error("Vault not initialized.");
      process.exit(1);
    }

    const password = await getPassword("Master password: ");
    await db.unlock(password);

    const daemon = new SecretKeeperDaemon();
    await daemon.loadSecrets(db);

    log.success(`Daemon started with ${daemon.getSecretCount()} secret(s)`);
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
  .action(async (commandParts, options) => {
    const client = new DaemonClient();

    if (!client.isRunning()) {
      log.error("Daemon not running. Start it with 'secret-keeper daemon'.");
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
  .action(async () => {
    const client = new DaemonClient();

    if (!client.isRunning()) {
      log.warning("Daemon not running.");
      log.dim("Start it with 'secret-keeper daemon'");
      process.exit(1);
    }

    try {
      const response = await client.ping();
      log.success("Daemon is running");
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
  .action(async () => {
    const client = new DaemonClient();

    if (!client.isRunning()) {
      log.warning("Daemon not running.");
      return;
    }

    try {
      await client.shutdown();
      log.success("Daemon stopped.");
    } catch {
      // Daemon may have already stopped
      log.success("Daemon stopped.");
    }
  });
