import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { spawn } from "child_process";
import { resolve } from "path";
import { openSync, closeSync, mkdirSync, existsSync } from "fs";
import { DaemonClient } from "../../daemon";
import { findProjectSocketPath, DEFAULT_SOCKET_PATH } from "../../types";

interface DaemonControlProps {
  onBack: () => void;
  daemonClient: DaemonClient;
  password: string | null;
  isProjectDaemon?: boolean;
  socketPath?: string;
}

interface DaemonStatus {
  running: boolean;
  secretsLoaded?: number;
  secrets?: string[];
}

export function DaemonControl({
  onBack,
  daemonClient,
  password,
  isProjectDaemon = false,
  socketPath = DEFAULT_SOCKET_PATH,
}: DaemonControlProps): React.ReactElement {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);
  const [showStartOptions, setShowStartOptions] = useState(false);
  const [rotationInterval, setRotationInterval] = useState("60");
  const [enableRotation, setEnableRotation] = useState(true);

  useInput((input, key) => {
    if (key.escape) {
      if (showStartOptions) {
        setShowStartOptions(false);
      } else {
        onBack();
      }
    }
  });

  const checkStatus = async () => {
    setIsLoading(true);
    try {
      if (daemonClient.isRunning()) {
        // Add timeout to prevent hanging on stale sockets
        const timeoutPromise = new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 2000)
        );

        const response = await Promise.race([
          daemonClient.ping(),
          timeoutPromise
        ]);

        if (response) {
          const secrets = await Promise.race([
            daemonClient.listSecrets(),
            timeoutPromise
          ]) as string[] | null;

          setStatus({
            running: true,
            secretsLoaded: response.secretsLoaded,
            secrets: secrets || [],
          });
        } else {
          setStatus({ running: false });
        }
      } else {
        setStatus({ running: false });
      }
    } catch {
      setStatus({ running: false });
    }
    setIsLoading(false);
  };

  useEffect(() => {
    checkStatus();
    // Poll status every 2 seconds
    const interval = setInterval(checkStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleStart = () => {
    setShowStartOptions(true);
  };

  const handleStartConfirm = async () => {
    setIsLoading(true);
    setMessage({ text: "Starting daemon...", color: "yellow" });

    try {
      // Try to get password from prop, keyfile, or env
      let daemonPassword = password;

      if (!daemonPassword) {
        // Try to read from keyfile
        const vaultDir = isProjectDaemon
          ? `${process.cwd()}/.secret-keeper`
          : `${process.env.HOME}/.secret-keeper`;
        const keyfilePath = `${vaultDir}/.keyfile`;

        if (existsSync(keyfilePath)) {
          const { readFileSync } = await import("fs");
          daemonPassword = readFileSync(keyfilePath, "utf-8").trim();
        }
      }

      if (!daemonPassword) {
        setMessage({
          text: "No password available. Run 'sk auto' or start daemon from CLI.",
          color: "red",
        });
        setIsLoading(false);
        setShowStartOptions(false);
        return;
      }

      const cwd = process.cwd();
      // Use the secret-keeper installation path
      const skDir = resolve(__dirname, "../..");
      const indexPath = resolve(skDir, "src/index.ts");

      // Build command args with absolute path
      const args = ["run", indexPath, "daemon"];
      if (!enableRotation) {
        args.push("--no-rotation");
      } else {
        args.push("--rotation-interval", rotationInterval);
      }

      // Determine bun path
      const bunPath = process.env.HOME + "/.bun/bin/bun";

      // Create log directory and file for daemon output
      const logDir = "/tmp/secret-keeper";
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
      }
      const logPath = `${logDir}/daemon.log`;
      const outFd = openSync(logPath, "a");

      // Spawn daemon as detached background process
      const child = spawn(bunPath, args, {
        detached: true,
        stdio: ["ignore", outFd, outFd],
        cwd,
        shell: true,
        env: {
          ...process.env,
          SECRET_KEEPER_PASSWORD: daemonPassword,
          HOME: process.env.HOME || "",
          PATH: process.env.PATH || "",
        },
      });

      // Handle spawn errors via promise
      const spawnResult = await new Promise<{ error: Error | null }>((res) => {
        let error: Error | null = null;
        child.on("error", (err) => {
          error = err;
        });
        child.unref();
        closeSync(outFd);

        // Wait for potential errors or startup
        setTimeout(() => res({ error }), 2000);
      });

      if (spawnResult.error) {
        setMessage({ text: `Spawn error: ${spawnResult.error.message}`, color: "red" });
        setIsLoading(false);
        return;
      }

      setShowStartOptions(false);

      // Check if daemon is running by looking for socket
      if (existsSync(socketPath)) {
        const daemonType = isProjectDaemon ? "Project daemon" : "Daemon";
        setMessage({ text: `${daemonType} started!`, color: "green" });
      } else {
        setMessage({ text: "Daemon may have failed. Check /tmp/secret-keeper/daemon.log", color: "yellow" });
      }
      await checkStatus();
    } catch (error) {
      setMessage({ text: `Failed to start daemon: ${error}`, color: "red" });
    }
    setIsLoading(false);
  };

  const handleStop = async () => {
    setIsLoading(true);
    try {
      await daemonClient.shutdown();
      setMessage({ text: "Daemon stopped.", color: "green" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await checkStatus();
    } catch {
      setMessage({ text: "Daemon stopped.", color: "green" });
      setStatus({ running: false });
    }
    setIsLoading(false);
  };

  if (isLoading && !status) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Daemon Control
        </Text>
        <Box marginTop={1}>
          <Text color="green">
            <Spinner type="dots" />
          </Text>
          <Text> Checking daemon status...</Text>
        </Box>
      </Box>
    );
  }

  if (showStartOptions) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Start Daemon
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Text>
            Enable automatic rotation:{" "}
            <Text color={enableRotation ? "green" : "red"}>
              {enableRotation ? "Yes" : "No"}
            </Text>
          </Text>
          {enableRotation && (
            <Box>
              <Text>Check interval (minutes): </Text>
              <TextInput
                value={rotationInterval}
                onChange={setRotationInterval}
                onSubmit={handleStartConfirm}
              />
            </Box>
          )}
        </Box>

        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: "▶️  Start Daemon", value: "start" },
              {
                label: enableRotation
                  ? "🔄 Disable Auto-Rotation"
                  : "🔄 Enable Auto-Rotation",
                value: "toggle-rotation",
              },
              { label: "← Cancel", value: "cancel" },
            ]}
            onSelect={(item) => {
              if (item.value === "start") {
                handleStartConfirm();
              } else if (item.value === "toggle-rotation") {
                setEnableRotation(!enableRotation);
              } else {
                setShowStartOptions(false);
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  const daemonType = isProjectDaemon ? "Project" : "Global";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Daemon Control ({daemonType})
      </Text>

      {/* Status display */}
      <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        <Box>
          <Text>Status: </Text>
          {status?.running ? (
            <Text color="green" bold>
              ● Running
            </Text>
          ) : (
            <Text color="red" bold>
              ○ Stopped
            </Text>
          )}
          {isLoading && (
            <Text color="gray">
              {" "}
              <Spinner type="dots" />
            </Text>
          )}
        </Box>
        <Text dimColor>Socket: {socketPath}</Text>

        {status?.running && (
          <>
            <Text>
              Secrets loaded: <Text color="yellow">{status.secretsLoaded}</Text>
            </Text>
            {status.secrets && status.secrets.length > 0 && (
              <Text dimColor>
                Available: {status.secrets.slice(0, 5).join(", ")}
                {status.secrets.length > 5 ? ` +${status.secrets.length - 5} more` : ""}
              </Text>
            )}
          </>
        )}
      </Box>

      {/* Message */}
      {message && (
        <Box marginY={1}>
          <Text color={message.color as any}>{message.text}</Text>
        </Box>
      )}

      {/* Actions */}
      <Box marginTop={1}>
        <SelectInput
          items={
            status?.running
              ? [
                  { label: "⏹️  Stop Daemon", value: "stop" },
                  { label: "🔄 Refresh Status", value: "refresh" },
                  { label: "← Back", value: "back" },
                ]
              : [
                  { label: "▶️  Start Daemon", value: "start" },
                  { label: "🔄 Refresh Status", value: "refresh" },
                  { label: "← Back", value: "back" },
                ]
          }
          onSelect={(item) => {
            setMessage(null);
            if (item.value === "start") {
              handleStart();
            } else if (item.value === "stop") {
              handleStop();
            } else if (item.value === "refresh") {
              checkStatus();
            } else {
              onBack();
            }
          }}
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {status?.running
            ? "Daemon is running. Commands can use 'sk exec' to run with secrets."
            : "Daemon is stopped. Start it to enable secure command execution."}
        </Text>
      </Box>
    </Box>
  );
}
