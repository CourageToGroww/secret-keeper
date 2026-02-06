import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { DaemonClient } from "../../daemon";
import {
  SOCKET_DIR,
  DEFAULT_SOCKET_PATH,
  SOCKET_NAME,
  LOCAL_DB_DIR,
  DEFAULT_DB_NAME,
  getProjectSocketPath,
  PROJECT_SCAN_DIRS,
} from "../../types";

interface DaemonInfo {
  name: string;
  socketPath: string;
  running: boolean;
  secretsLoaded?: number;
  projectPath?: string;
}

interface DaemonListProps {
  onBack: () => void;
}

/**
 * Build a map from socket path -> { name, projectPath } by scanning
 * known directories for project vaults and computing their socket paths.
 */
function buildSocketToProjectMap(): Map<string, { name: string; projectPath: string }> {
  const map = new Map<string, { name: string; projectPath: string }>();

  for (const scanDir of PROJECT_SCAN_DIRS) {
    if (!existsSync(scanDir)) continue;
    try {
      const entries = readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectPath = join(scanDir, entry.name);
        const dbPath = join(projectPath, LOCAL_DB_DIR, DEFAULT_DB_NAME);
        if (existsSync(dbPath)) {
          const socketPath = getProjectSocketPath(projectPath);
          if (!map.has(socketPath)) {
            map.set(socketPath, { name: entry.name, projectPath });
          }
        }
      }
    } catch {
      // Permission denied or other error, skip
    }
  }

  return map;
}

export function DaemonList({ onBack }: DaemonListProps): React.ReactElement {
  const [daemons, setDaemons] = useState<DaemonInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedDaemon, setSelectedDaemon] = useState<DaemonInfo | null>(null);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);

  useInput((input, key) => {
    if (key.escape) {
      if (selectedDaemon) {
        setSelectedDaemon(null);
      } else {
        onBack();
      }
    }
  });

  const scanForDaemons = async () => {
    setIsLoading(true);
    const found: DaemonInfo[] = [];

    try {
      // Check if socket directory exists
      if (!existsSync(SOCKET_DIR)) {
        setDaemons([]);
        setIsLoading(false);
        return;
      }

      // Build socket-to-project mapping so we can show real names
      const socketMap = buildSocketToProjectMap();

      // Scan for socket files
      const files = readdirSync(SOCKET_DIR);
      const socketFiles = files.filter(f => f.endsWith(".sock"));

      for (const socketFile of socketFiles) {
        const socketPath = `${SOCKET_DIR}/${socketFile}`;
        const client = new DaemonClient(socketPath);

        let daemonInfo: DaemonInfo;

        if (socketFile === SOCKET_NAME) {
          // Global daemon
          daemonInfo = {
            name: "Global",
            socketPath,
            running: false,
          };
        } else if (socketFile.startsWith("project-")) {
          // Project daemon - resolve to directory name via socket map
          const mapped = socketMap.get(socketPath);
          daemonInfo = {
            name: mapped ? mapped.name : socketFile.replace(".sock", ""),
            socketPath,
            running: false,
            projectPath: mapped?.projectPath,
          };
        } else {
          // Unknown socket
          daemonInfo = {
            name: socketFile,
            socketPath,
            running: false,
          };
        }

        // Check if daemon is actually running
        if (client.isRunning()) {
          try {
            const ping = await Promise.race([
              client.ping(),
              new Promise<null>((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), 1000)
              ),
            ]);

            if (ping) {
              daemonInfo.running = true;
              daemonInfo.secretsLoaded = ping.secretsLoaded;
            }
          } catch {
            // Socket exists but daemon not responding
            daemonInfo.running = false;
          }
        }

        found.push(daemonInfo);
      }

      // Sort: running first, then by name
      found.sort((a, b) => {
        if (a.running && !b.running) return -1;
        if (!a.running && b.running) return 1;
        return a.name.localeCompare(b.name);
      });

      setDaemons(found);
    } catch (error) {
      setMessage({ text: `Error scanning: ${error}`, color: "red" });
    }

    setIsLoading(false);
  };

  useEffect(() => {
    scanForDaemons();
    // Refresh every 5 seconds
    const interval = setInterval(scanForDaemons, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleStopDaemon = async (daemon: DaemonInfo) => {
    setActionInProgress(true);
    setMessage({ text: `Stopping ${daemon.name} daemon...`, color: "yellow" });

    try {
      const client = new DaemonClient(daemon.socketPath);
      await client.shutdown();
      setMessage({ text: `${daemon.name} daemon stopped.`, color: "green" });
      await scanForDaemons();
    } catch {
      setMessage({ text: `${daemon.name} daemon stopped.`, color: "green" });
      await scanForDaemons();
    }

    setActionInProgress(false);
    setSelectedDaemon(null);
  };

  const handleStopAll = async () => {
    setActionInProgress(true);
    setMessage({ text: "Stopping all daemons...", color: "yellow" });

    let stopped = 0;
    for (const daemon of daemons.filter(d => d.running)) {
      try {
        const client = new DaemonClient(daemon.socketPath);
        await client.shutdown();
        stopped++;
      } catch {
        stopped++;
      }
    }

    setMessage({ text: `Stopped ${stopped} daemon(s).`, color: "green" });
    await scanForDaemons();
    setActionInProgress(false);
  };

  const handleCleanStale = async () => {
    setActionInProgress(true);
    setMessage({ text: "Cleaning stale sockets...", color: "yellow" });

    let cleaned = 0;
    const { unlinkSync } = await import("fs");

    for (const daemon of daemons.filter(d => !d.running)) {
      try {
        unlinkSync(daemon.socketPath);
        cleaned++;
      } catch {
        // Ignore errors
      }
    }

    setMessage({ text: `Removed ${cleaned} stale socket(s).`, color: "green" });
    await scanForDaemons();
    setActionInProgress(false);
  };

  // Daemon detail view
  if (selectedDaemon) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Daemon: {selectedDaemon.name}
        </Text>

        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text>
            Status:{" "}
            {selectedDaemon.running ? (
              <Text color="green" bold>Running</Text>
            ) : (
              <Text color="red" bold>Stopped</Text>
            )}
          </Text>
          <Text dimColor>Socket: {selectedDaemon.socketPath}</Text>
          {selectedDaemon.running && selectedDaemon.secretsLoaded !== undefined && (
            <Text>Secrets loaded: <Text color="yellow">{selectedDaemon.secretsLoaded}</Text></Text>
          )}
          {selectedDaemon.projectPath && (
            <Text dimColor>Project: {selectedDaemon.projectPath}</Text>
          )}
        </Box>

        {message && (
          <Box marginY={1}>
            <Text color={message.color as any}>{message.text}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          {actionInProgress ? (
            <Text color="yellow">
              <Spinner type="dots" /> Working...
            </Text>
          ) : (
            <SelectInput
              items={
                selectedDaemon.running
                  ? [
                      { label: "Stop Daemon", value: "stop" },
                      { label: "Back", value: "back" },
                    ]
                  : [
                      { label: "Remove Stale Socket", value: "clean" },
                      { label: "Back", value: "back" },
                    ]
              }
              onSelect={(item) => {
                if (item.value === "stop") {
                  handleStopDaemon(selectedDaemon);
                } else if (item.value === "clean") {
                  import("fs").then(({ unlinkSync }) => {
                    try {
                      unlinkSync(selectedDaemon.socketPath);
                      setMessage({ text: "Socket removed.", color: "green" });
                      scanForDaemons();
                      setSelectedDaemon(null);
                    } catch (e) {
                      setMessage({ text: `Failed to remove: ${e}`, color: "red" });
                    }
                  });
                } else {
                  setSelectedDaemon(null);
                }
              }}
            />
          )}
        </Box>
      </Box>
    );
  }

  // Main list view
  const runningCount = daemons.filter(d => d.running).length;
  const staleCount = daemons.filter(d => !d.running).length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Running Daemons
      </Text>

      {isLoading && daemons.length === 0 ? (
        <Box marginTop={1}>
          <Text color="green">
            <Spinner type="dots" />
          </Text>
          <Text> Scanning for daemons...</Text>
        </Box>
      ) : (
        <>
          {/* Summary */}
          <Box marginTop={1}>
            <Text>
              <Text color="green" bold>{runningCount}</Text> running
              {staleCount > 0 && (
                <Text>, <Text color="yellow">{staleCount}</Text> stale</Text>
              )}
              {isLoading && (
                <Text color="gray"> <Spinner type="dots" /></Text>
              )}
            </Text>
          </Box>

          {/* Daemon list */}
          {daemons.length > 0 ? (
            <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
              {daemons.map((daemon, i) => (
                <Box key={daemon.socketPath}>
                  <Text>
                    {daemon.running ? (
                      <Text color="green">●</Text>
                    ) : (
                      <Text color="gray">○</Text>
                    )}
                    {" "}
                    <Text bold={daemon.running}>{daemon.name}</Text>
                    {daemon.running && daemon.secretsLoaded !== undefined && (
                      <Text dimColor> ({daemon.secretsLoaded} secrets)</Text>
                    )}
                    {!daemon.running && <Text dimColor> (stale socket)</Text>}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text dimColor>No daemons found.</Text>
            </Box>
          )}

          {/* Message */}
          {message && (
            <Box marginY={1}>
              <Text color={message.color as any}>{message.text}</Text>
            </Box>
          )}

          {/* Actions */}
          <Box marginTop={1}>
            {actionInProgress ? (
              <Text color="yellow">
                <Spinner type="dots" /> Working...
              </Text>
            ) : daemons.length > 0 ? (
              <>
                <Text dimColor>Select a daemon to manage:</Text>
                <SelectInput
                  items={[
                    ...daemons.map(d => ({
                      label: `${d.running ? "●" : "○"} ${d.name}${d.running ? ` (${d.secretsLoaded} secrets)` : " (stale)"}`,
                      value: d.socketPath,
                    })),
                    { label: "─────────────", value: "separator" },
                    ...(runningCount > 1
                      ? [{ label: "⏹  Stop All Daemons", value: "stop-all" }]
                      : []),
                    ...(staleCount > 0
                      ? [{ label: "🧹 Clean Stale Sockets", value: "clean" }]
                      : []),
                    { label: "🔄 Refresh", value: "refresh" },
                    { label: "← Back", value: "back" },
                  ]}
                  onSelect={(item) => {
                    if (item.value === "separator") return;
                    setMessage(null);
                    if (item.value === "stop-all") {
                      handleStopAll();
                    } else if (item.value === "clean") {
                      handleCleanStale();
                    } else if (item.value === "refresh") {
                      scanForDaemons();
                    } else if (item.value === "back") {
                      onBack();
                    } else {
                      // It's a daemon socket path
                      const daemon = daemons.find(d => d.socketPath === item.value);
                      if (daemon) {
                        setSelectedDaemon(daemon);
                      }
                    }
                  }}
                />
              </>
            ) : (
              <SelectInput
                items={[
                  { label: "🔄 Refresh", value: "refresh" },
                  { label: "← Back", value: "back" },
                ]}
                onSelect={(item) => {
                  setMessage(null);
                  if (item.value === "refresh") {
                    scanForDaemons();
                  } else if (item.value === "back") {
                    onBack();
                  }
                }}
              />
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
