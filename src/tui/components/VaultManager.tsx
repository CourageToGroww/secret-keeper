import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { spawn } from "child_process";
import { openSync, closeSync } from "fs";
import { DaemonClient } from "../../daemon";
import { generateMasterKey } from "../../crypto";
import { SecretDatabase } from "../../database";
import { LOCAL_DB_DIR, getProjectSocketPath, DEFAULT_SOCKET_PATH } from "../../types";

interface VaultManagerProps {
  vaultPath: string;
  isLocal: boolean;
  secretCount: number;
  onChangePassword: (current: string, newPass: string) => Promise<void>;
  onBack: () => void;
  onReset?: () => void; // Called after reset to refresh app state
}

type Screen = "info" | "change-password" | "reset-confirm" | "reset-complete";

export function VaultManager({
  vaultPath,
  isLocal,
  secretCount,
  onChangePassword,
  onBack,
  onReset,
}: VaultManagerProps): React.ReactElement {
  const [screen, setScreen] = useState<Screen>("info");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordStep, setPasswordStep] = useState<"current" | "new" | "confirm">("current");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);
  const [resetResult, setResetResult] = useState<{ newKey: string; keyFilePath: string } | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      if (screen === "info") {
        onBack();
      } else if (screen === "reset-complete") {
        // After reset, go back to main menu
        if (onReset) onReset();
        onBack();
      } else {
        setScreen("info");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setPasswordStep("current");
        setMessage(null);
      }
    }
  });

  const handleReset = async (reinit: boolean) => {
    setIsLoading(true);
    setMessage({ text: "Resetting vault...", color: "yellow" });

    try {
      // Determine vault directory
      const vaultDir = isLocal
        ? join(process.cwd(), LOCAL_DB_DIR)
        : join(process.env.HOME || "", ".secret-keeper");

      // Step 1: Stop daemon if running
      const socketPath = isLocal
        ? getProjectSocketPath(process.cwd())
        : DEFAULT_SOCKET_PATH;

      const client = new DaemonClient(socketPath);
      if (client.isRunning()) {
        try {
          await client.shutdown();
        } catch {
          // Ignore
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Remove stale socket
      if (existsSync(socketPath)) {
        try {
          const { unlinkSync } = await import("fs");
          unlinkSync(socketPath);
        } catch {
          // Ignore
        }
      }

      // Step 2: Remove vault directory
      rmSync(vaultDir, { recursive: true, force: true });

      if (!reinit) {
        setMessage({ text: "Vault removed. Run 'sk auto' to reinitialize.", color: "green" });
        setIsLoading(false);
        return;
      }

      // Step 3: Reinitialize
      setMessage({ text: "Reinitializing vault...", color: "yellow" });

      const password = generateMasterKey();

      // Create vault directory
      mkdirSync(vaultDir, { recursive: true, mode: 0o700 });

      // Initialize vault
      const db = new SecretDatabase(undefined, isLocal);
      await db.initialize(password);

      // Save keyfile
      const keyFilePath = join(vaultDir, ".keyfile");
      writeFileSync(keyFilePath, password, { mode: 0o600 });

      // Create .gitignore for local vaults
      if (isLocal) {
        const gitignorePath = join(vaultDir, ".gitignore");
        writeFileSync(gitignorePath, "*\n");
      }

      // Start daemon
      setMessage({ text: "Starting daemon...", color: "yellow" });

      const cwd = process.cwd();
      const skDir = resolve(__dirname, "../..");
      const indexPath = resolve(skDir, "src/index.ts");
      const bunPath = (process.env.HOME || "") + "/.bun/bin/bun";

      const args = ["run", indexPath, "daemon"];
      if (isLocal) {
        args.push("--project", cwd);
      } else {
        args.push("--global");
      }

      const logDir = "/tmp/secret-keeper";
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
      }

      const logPath = `${logDir}/daemon.log`;
      const outFd = openSync(logPath, "a");

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

      await new Promise((resolve) => setTimeout(resolve, 1500));

      db.close();

      // Show success with new key
      setResetResult({ newKey: password, keyFilePath });
      setScreen("reset-complete");
      setMessage(null);
    } catch (error) {
      setMessage({ text: `Reset failed: ${error}`, color: "red" });
    }

    setIsLoading(false);
  };

  const handlePasswordSubmit = async () => {
    if (passwordStep === "current") {
      if (currentPassword.length >= 8) {
        setPasswordStep("new");
      } else {
        setMessage({ text: "Password must be at least 8 characters", color: "red" });
      }
      return;
    }

    if (passwordStep === "new") {
      if (newPassword.length >= 8) {
        setPasswordStep("confirm");
      } else {
        setMessage({ text: "Password must be at least 8 characters", color: "red" });
      }
      return;
    }

    if (passwordStep === "confirm") {
      if (confirmPassword !== newPassword) {
        setMessage({ text: "Passwords do not match", color: "red" });
        return;
      }

      setIsLoading(true);
      try {
        await onChangePassword(currentPassword, newPassword);
        setMessage({ text: "Password changed successfully!", color: "green" });
        setScreen("info");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setPasswordStep("current");
      } catch (error) {
        setMessage({ text: `Error: ${error}`, color: "red" });
      }
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text color="green">
            <Spinner type="dots" />
          </Text>
          <Text> Changing password (re-encrypting all secrets)...</Text>
        </Box>
      </Box>
    );
  }

  if (screen === "reset-complete" && resetResult) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="green">
          ✓ Vault Reset Complete
        </Text>

        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">
            YOUR NEW MASTER KEY (save this somewhere safe!):
          </Text>
          <Text> </Text>
          <Text bold color="cyan">{resetResult.newKey}</Text>
          <Text> </Text>
          <Text dimColor>Also saved to: {resetResult.keyFilePath}</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color="green">✓ Vault reinitialized</Text>
          <Text color="green">✓ Daemon started</Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Press Escape to continue</Text>
        </Box>
      </Box>
    );
  }

  if (screen === "reset-confirm") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="red">
          ⚠️  Reset Vault
        </Text>

        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="red" paddingX={1}>
          <Text color="red" bold>WARNING: This will permanently delete:</Text>
          <Text> </Text>
          <Text>  • All {secretCount} stored secrets</Text>
          <Text>  • All rotation configurations</Text>
          <Text>  • All audit history</Text>
          <Text> </Text>
          <Text color="yellow">Vault: {vaultPath}</Text>
        </Box>

        {message && (
          <Box marginY={1}>
            <Text color={message.color as any}>{message.text}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          {isLoading ? (
            <Text color="yellow">
              <Spinner type="dots" /> Working...
            </Text>
          ) : (
            <SelectInput
              items={[
                { label: "🔄 Reset & Reinitialize (generates new key)", value: "reset-reinit" },
                { label: "🗑️  Reset Only (delete vault)", value: "reset-only" },
                { label: "← Cancel", value: "cancel" },
              ]}
              onSelect={(item) => {
                if (item.value === "reset-reinit") {
                  handleReset(true);
                } else if (item.value === "reset-only") {
                  handleReset(false);
                } else {
                  setScreen("info");
                  setMessage(null);
                }
              }}
            />
          )}
        </Box>
      </Box>
    );
  }

  if (screen === "change-password") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Change Master Password
        </Text>

        {message && (
          <Box marginY={1}>
            <Text color={message.color as any}>{message.text}</Text>
          </Box>
        )}

        <Box marginTop={1} flexDirection="column">
          {passwordStep === "current" && (
            <>
              <Text>Current password:</Text>
              <TextInput
                value={currentPassword}
                onChange={setCurrentPassword}
                onSubmit={handlePasswordSubmit}
                mask="*"
              />
            </>
          )}

          {passwordStep === "new" && (
            <>
              <Text dimColor>Current password: ********</Text>
              <Text>New password (min 8 characters):</Text>
              <TextInput
                value={newPassword}
                onChange={setNewPassword}
                onSubmit={handlePasswordSubmit}
                mask="*"
              />
            </>
          )}

          {passwordStep === "confirm" && (
            <>
              <Text dimColor>Current password: ********</Text>
              <Text dimColor>New password: ********</Text>
              <Text>Confirm new password:</Text>
              <TextInput
                value={confirmPassword}
                onChange={setConfirmPassword}
                onSubmit={handlePasswordSubmit}
                mask="*"
              />
            </>
          )}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Press Enter to continue, Escape to cancel</Text>
        </Box>
      </Box>
    );
  }

  // Info screen
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Vault Information
      </Text>

      {message && (
        <Box marginY={1}>
          <Text color={message.color as any}>{message.text}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        <Text>
          Location: <Text color="yellow">{vaultPath}</Text>
        </Text>
        <Text>
          Type: <Text color="yellow">{isLocal ? "Project-local" : "Global"}</Text>
        </Text>
        <Text>
          Secrets stored: <Text color="yellow">{secretCount}</Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: "🔑 Change Master Password", value: "change-password" },
            { label: "🔄 Reset Vault", value: "reset" },
            { label: "← Back", value: "back" },
          ]}
          onSelect={(item) => {
            setMessage(null);
            if (item.value === "change-password") {
              setScreen("change-password");
            } else if (item.value === "reset") {
              setScreen("reset-confirm");
            } else {
              onBack();
            }
          }}
        />
      </Box>
    </Box>
  );
}
