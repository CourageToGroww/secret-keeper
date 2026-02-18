import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { readdirSync, existsSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { DaemonClient } from "../../daemon";
import {
  LOCAL_DB_DIR,
  DEFAULT_DB_NAME,
  SOCKET_DIR,
  getProjectSocketPath,
  DEFAULT_SOCKET_PATH,
  PROJECT_SCAN_DIRS,
} from "../../types";

interface ProjectInfo {
  path: string;
  name: string;
  hasKeyfile: boolean;
  secretCount: number;
  daemonRunning: boolean;
  isGlobal: boolean;
}

interface ProjectsProps {
  onBack: () => void;
}

export function Projects({ onBack }: ProjectsProps): React.ReactElement {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      if (selectedProject) {
        setSelectedProject(null);
      } else {
        onBack();
      }
    }
  });

  const scanForProjects = async () => {
    setIsLoading(true);
    const found: ProjectInfo[] = [];
    const seenPaths = new Set<string>();

    // Check global vault first
    const globalVaultPath = join(process.env.HOME || "", ".secret-keeper", DEFAULT_DB_NAME);
    if (existsSync(globalVaultPath)) {
      const globalKeyfile = join(process.env.HOME || "", ".secret-keeper", ".keyfile");
      const globalClient = new DaemonClient(DEFAULT_SOCKET_PATH);
      let daemonRunning = false;

      if (globalClient.isRunning()) {
        try {
          await globalClient.ping();
          daemonRunning = true;
        } catch {}
      }

      found.push({
        path: join(process.env.HOME || "", ".secret-keeper"),
        name: "Global Vault (~/.secret-keeper)",
        hasKeyfile: existsSync(globalKeyfile),
        secretCount: -1, // Unknown without unlocking
        daemonRunning,
        isGlobal: true,
      });
      seenPaths.add(join(process.env.HOME || "", ".secret-keeper"));
    }

    // Scan directories for project vaults
    for (const scanDir of PROJECT_SCAN_DIRS) {
      if (!existsSync(scanDir)) continue;

      try {
        const entries = readdirSync(scanDir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const projectPath = join(scanDir, entry.name);
          const vaultPath = join(projectPath, LOCAL_DB_DIR);
          const dbPath = join(vaultPath, DEFAULT_DB_NAME);

          if (seenPaths.has(vaultPath)) continue;

          if (existsSync(dbPath)) {
            seenPaths.add(vaultPath);

            const keyfilePath = join(vaultPath, ".keyfile");
            const socketPath = getProjectSocketPath(projectPath);
            const client = new DaemonClient(socketPath);

            let daemonRunning = false;
            if (client.isRunning()) {
              try {
                await client.ping();
                daemonRunning = true;
              } catch {}
            }

            found.push({
              path: projectPath,
              name: entry.name,
              hasKeyfile: existsSync(keyfilePath),
              secretCount: -1,
              daemonRunning,
              isGlobal: false,
            });
          }
        }
      } catch {
        // Permission denied or other error, skip
      }
    }

    // Sort: running daemons first, then by name
    found.sort((a, b) => {
      if (a.daemonRunning && !b.daemonRunning) return -1;
      if (!a.daemonRunning && b.daemonRunning) return 1;
      if (a.isGlobal) return -1;
      if (b.isGlobal) return 1;
      return a.name.localeCompare(b.name);
    });

    setProjects(found);
    setIsLoading(false);
  };

  useEffect(() => {
    scanForProjects();
  }, []);

  // Project detail view
  if (selectedProject) {
    const keyfilePath = selectedProject.isGlobal
      ? join(process.env.HOME || "", ".secret-keeper", ".keyfile")
      : join(selectedProject.path, LOCAL_DB_DIR, ".keyfile");

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Project: {selectedProject.name}
        </Text>

        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text>Path: <Text dimColor>{selectedProject.path}</Text></Text>
          <Text>
            Daemon:{" "}
            {selectedProject.daemonRunning ? (
              <Text color="green" bold>Running</Text>
            ) : (
              <Text color="gray">Stopped</Text>
            )}
          </Text>
          <Text>
            Keyfile:{" "}
            {selectedProject.hasKeyfile ? (
              <Text color="green">Present (auto-start enabled)</Text>
            ) : (
              <Text color="yellow">None (run 'sk init' to create)</Text>
            )}
          </Text>
          {selectedProject.hasKeyfile && (
            <Box marginTop={1}>
              <Text dimColor>Keyfile: {keyfilePath}</Text>
            </Box>
          )}
        </Box>

        {message && (
          <Box marginY={1}>
            <Text color={message.color as any}>{message.text}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <SelectInput
            items={[
              ...(selectedProject.daemonRunning
                ? [{ label: "⏹  Stop Daemon", value: "stop" }]
                : []),
              { label: "📋 Copy Path", value: "copy" },
              { label: "← Back", value: "back" },
            ]}
            onSelect={async (item) => {
              if (item.value === "stop") {
                const socketPath = selectedProject.isGlobal
                  ? DEFAULT_SOCKET_PATH
                  : getProjectSocketPath(selectedProject.path);
                const client = new DaemonClient(socketPath);
                try {
                  await client.shutdown();
                  setMessage({ text: "Daemon stopped.", color: "green" });
                  await scanForProjects();
                  setSelectedProject(null);
                } catch {
                  setMessage({ text: "Daemon stopped.", color: "green" });
                  await scanForProjects();
                  setSelectedProject(null);
                }
              } else if (item.value === "copy") {
                setMessage({ text: `Path: ${selectedProject.path}`, color: "cyan" });
              } else {
                setSelectedProject(null);
              }
            }}
          />
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            To work with this project:{"\n"}
            cd {selectedProject.path}{"\n"}
            sk status
          </Text>
        </Box>
      </Box>
    );
  }

  // Main list view
  const runningCount = projects.filter(p => p.daemonRunning).length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Secret Keeper Projects
      </Text>

      {isLoading ? (
        <Box marginTop={1}>
          <Text color="green">
            <Spinner type="dots" />
          </Text>
          <Text> Scanning for projects...</Text>
        </Box>
      ) : (
        <>
          <Box marginTop={1}>
            <Text>
              Found <Text bold color="yellow">{projects.length}</Text> project(s)
              {runningCount > 0 && (
                <Text>, <Text color="green">{runningCount}</Text> with daemon running</Text>
              )}
            </Text>
          </Box>

          {projects.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Select a project:</Text>
              <SelectInput
                items={[
                  ...projects.map(p => ({
                    label: `${p.daemonRunning ? "●" : "○"} ${p.name}${p.hasKeyfile ? "" : " (no keyfile)"}`,
                    value: p.path,
                  })),
                  { label: "─────────────", value: "separator" },
                  { label: "🔄 Rescan", value: "rescan" },
                  { label: "← Back", value: "back" },
                ]}
                onSelect={(item) => {
                  if (item.value === "separator") return;
                  if (item.value === "rescan") {
                    scanForProjects();
                  } else if (item.value === "back") {
                    onBack();
                  } else {
                    const project = projects.find(p => p.path === item.value);
                    if (project) {
                      setSelectedProject(project);
                    }
                  }
                }}
              />
            </Box>
          ) : (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>No projects with Secret Keeper found.</Text>
              <Text dimColor>Run 'sk auto' in a project directory to set it up.</Text>
              <Box marginTop={1}>
                <SelectInput
                  items={[
                    { label: "🔄 Rescan", value: "rescan" },
                    { label: "← Back", value: "back" },
                  ]}
                  onSelect={(item) => {
                    if (item.value === "rescan") {
                      scanForProjects();
                    } else {
                      onBack();
                    }
                  }}
                />
              </Box>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
