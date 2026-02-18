import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
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
  onBack: () => void;
  onReset?: () => void;
}

type Screen = "info" | "reset-confirm" | "reset-complete";

export function VaultManager({
  vaultPath,
  isLocal,
  secretCount,
  onBack,
  onReset,
}: VaultManagerProps): React.ReactElement {
  const [screen, setScreen] = useState<Screen>("info");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);
  const [resetResult, setResetResult] = useState<{ newKey: string; keyFilePath: string } | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      if (screen === "info") {
        onBack();
      } else if (screen === "reset-complete") {
        if (onReset) onReset();
        onBack();
      } else {
        setScreen("info");
        setMessage(null);
      }
    }
  });

  const handleReset = async (reinit: boolean) => {
    setIsLoading(true);
    setMessage({ text: "Resetting vault...", color: "yellow" });

    try {
      const vaultDir = isLocal
        ? join(process.cwd(), LOCAL_DB_DIR)
        : join(process.env.HOME || "", ".secret-keeper");

      // Stop daemon if running
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

      // Remove vault directory
      rmSync(vaultDir, { recursive: true, force: true });

      if (!reinit) {
        setMessage({ text: "Vault removed. Run 'sk auto' to reinitialize.", color: "green" });
        setIsLoading(false);
        return;
      }

      // Reinitialize
      setMessage({ text: "Reinitializing vault...", color: "yellow" });

      const key = generateMasterKey();

      mkdirSync(vaultDir, { recursive: true, mode: 0o700 });

      const db = new SecretDatabase(undefined, isLocal);
      await db.initialize(key);

      const keyFilePath = join(vaultDir, ".keyfile");
      writeFileSync(keyFilePath, key, { mode: 0o600 });

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
          SECRET_KEEPER_PASSWORD: key,
          HOME: process.env.HOME || "",
          PATH: process.env.PATH || "",
        },
      });

      child.unref();
      closeSync(outFd);

      await new Promise((resolve) => setTimeout(resolve, 1500));

      db.close();

      setResetResult({ newKey: key, keyFilePath });
      setScreen("reset-complete");
      setMessage(null);
    } catch (error) {
      setMessage({ text: `Reset failed: ${error}`, color: "red" });
    }

    setIsLoading(false);
  };

  if (isLoading) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text color="green">
            <Spinner type="dots" />
          </Text>
          <Text> Working...</Text>
        </Box>
      </Box>
    );
  }

  if (screen === "reset-complete" && resetResult) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="green">
          Vault Reset Complete
        </Text>

        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">
            YOUR NEW ENCRYPTION KEY (saved to keyfile):
          </Text>
          <Text> </Text>
          <Text bold color="cyan">{resetResult.newKey}</Text>
          <Text> </Text>
          <Text dimColor>Keyfile: {resetResult.keyFilePath}</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color="green">Vault reinitialized</Text>
          <Text color="green">Daemon started</Text>
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
          Reset Vault
        </Text>

        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="red" paddingX={1}>
          <Text color="red" bold>WARNING: This will permanently delete:</Text>
          <Text> </Text>
          <Text>  - All {secretCount} stored secrets</Text>
          <Text>  - All rotation configurations</Text>
          <Text>  - All audit history</Text>
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
                { label: "Reset & Reinitialize (generates new key)", value: "reset-reinit" },
                { label: "Reset Only (delete vault)", value: "reset-only" },
                { label: "Cancel", value: "cancel" },
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
            { label: "Reset Vault", value: "reset" },
            { label: "Back", value: "back" },
          ]}
          onSelect={(item) => {
            setMessage(null);
            if (item.value === "reset") {
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
