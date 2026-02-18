import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { SecretDatabase } from "../database";
import { RotationManager } from "../rotation";
import { DaemonClient } from "../daemon";
import { ProviderType, ProviderConfig, findProjectSocketPath, DEFAULT_SOCKET_PATH, getProjectSocketPath } from "../types";
import { useDatabase } from "./hooks/useDatabase";
import { Menu, MenuItem } from "./components/Menu";
import { SecretsManager } from "./components/SecretsManager";
import { DaemonControl } from "./components/DaemonControl";
import { StatusDashboard } from "./components/StatusDashboard";
import { RotationList } from "./components/RotationList";
import { ConfigureRotation } from "./components/ConfigureRotation";
import { RotationHistory } from "./components/RotationHistory";
import { VaultManager } from "./components/VaultManager";
import { ImportExport } from "./components/ImportExport";
import { AuditLog } from "./components/AuditLog";
import { DaemonList } from "./components/DaemonList";
import { Docs } from "./components/Docs";
import { Projects } from "./components/Projects";

type Screen =
  | "menu"
  | "secrets"
  | "daemon"
  | "daemon-list"
  | "projects"
  | "rotation-status"
  | "rotation-list"
  | "rotation-configure"
  | "rotation-history"
  | "vault"
  | "import-export"
  | "audit"
  | "docs";

interface AppProps {
  db: SecretDatabase;
  manager: RotationManager;
}

const MAIN_MENU_ITEMS: MenuItem[] = [
  { label: "Manage Secrets", value: "secrets" },
  { label: "Daemon Control", value: "daemon" },
  { label: "Running Daemons", value: "daemon-list" },
  { label: "All Projects", value: "projects" },
  { label: "Rotation Status", value: "rotation-status" },
  { label: "Configure Rotations", value: "rotation-list" },
  { label: "Rotation History", value: "rotation-history" },
  { label: "Import / Export", value: "import-export" },
  { label: "Vault Settings", value: "vault" },
  { label: "Audit Log", value: "audit" },
  { label: "Documentation", value: "docs" },
  { label: "Exit", value: "exit" },
];

export function App({ db, manager }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("menu");
  const [state, actions] = useDatabase(db, manager);

  // Determine project-aware socket path
  const socketPath = state.isLocal ? getProjectSocketPath(process.cwd()) : DEFAULT_SOCKET_PATH;
  const isProjectDaemon = socketPath !== DEFAULT_SOCKET_PATH;
  const [daemonClient] = useState(() => new DaemonClient(socketPath));
  const [allSecrets, setAllSecrets] = useState<Record<string, string>>({});

  // Load all secrets for export feature
  useEffect(() => {
    actions.getAllSecrets().then(setAllSecrets).catch(() => {});
  }, [state.secrets]);

  useInput((input, key) => {
    if (input === "q" && screen === "menu") {
      exit();
    }
  });

  const handleMenuSelect = (item: MenuItem) => {
    switch (item.value) {
      case "secrets":
        setScreen("secrets");
        break;
      case "daemon":
        setScreen("daemon");
        break;
      case "daemon-list":
        setScreen("daemon-list");
        break;
      case "projects":
        setScreen("projects");
        break;
      case "rotation-status":
        setScreen("rotation-status");
        break;
      case "rotation-list":
        setScreen("rotation-list");
        break;
      case "rotation-history":
        setScreen("rotation-history");
        break;
      case "import-export":
        setScreen("import-export");
        break;
      case "vault":
        setScreen("vault");
        break;
      case "audit":
        setScreen("audit");
        break;
      case "docs":
        setScreen("docs");
        break;
      case "exit":
        exit();
        break;
    }
  };

  const handleBack = () => {
    actions.refresh();
    setScreen("menu");
  };

  const handleSaveRotationConfig = async (
    secretName: string,
    providerType: ProviderType,
    scheduleDays: number,
    providerConfig: ProviderConfig
  ) => {
    await actions.configureRotation(secretName, providerType, scheduleDays, providerConfig);
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        marginBottom={1}
        justifyContent="center"
      >
        <Text bold color="cyan">
          Secret Keeper
        </Text>
      </Box>

      {/* Screen content */}
      {screen === "menu" && (
        <Menu
          items={MAIN_MENU_ITEMS}
          onSelect={handleMenuSelect}
        />
      )}

      {screen === "secrets" && (
        <SecretsManager
          secrets={state.secrets}
          onAddSecret={actions.addSecret}
          onDeleteSecret={actions.deleteSecret}
          onGetSecret={actions.getSecret}
          onBack={handleBack}
        />
      )}

      {screen === "daemon" && (
        <DaemonControl
          daemonClient={daemonClient}
          onBack={handleBack}
          isProjectDaemon={isProjectDaemon}
          socketPath={socketPath}
        />
      )}

      {screen === "daemon-list" && (
        <DaemonList onBack={handleBack} />
      )}

      {screen === "projects" && (
        <Projects onBack={handleBack} />
      )}

      {screen === "rotation-status" && (
        <StatusDashboard
          secrets={state.secrets}
          rotationConfigs={state.rotationConfigs}
          onBack={handleBack}
        />
      )}

      {screen === "rotation-list" && (
        <RotationList
          configs={state.rotationConfigs}
          onRotateNow={actions.rotateNow}
          onToggle={(name, enabled) =>
            enabled ? actions.enableRotation(name) : actions.disableRotation(name)
          }
          onDelete={actions.deleteRotationConfig}
          onTest={actions.testRotation}
          onBack={handleBack}
          onAddNew={() => setScreen("rotation-configure")}
        />
      )}

      {screen === "rotation-configure" && (
        <ConfigureRotation
          secrets={state.secrets}
          existingConfigs={state.rotationConfigs.map((c) => c.secretName)}
          onSave={handleSaveRotationConfig}
          onBack={handleBack}
        />
      )}

      {screen === "rotation-history" && (
        <RotationHistory
          history={state.rotationHistory}
          secrets={state.secrets}
          onBack={handleBack}
        />
      )}

      {screen === "import-export" && (
        <ImportExport
          secrets={allSecrets}
          onImportEntry={actions.addSecretEntry}
          onDelete={actions.deleteSecret}
          onBack={handleBack}
        />
      )}

      {screen === "vault" && (
        <VaultManager
          vaultPath={state.vaultPath}
          isLocal={state.isLocal}
          secretCount={state.secretCount}
          onBack={handleBack}
        />
      )}

      {screen === "audit" && (
        <AuditLog
          entries={state.auditLog}
          onBack={handleBack}
        />
      )}

      {screen === "docs" && (
        <Docs onBack={handleBack} />
      )}

      {/* Footer */}
      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          {state.secretCount} secrets | {state.rotationConfigs.length} rotations |{" "}
          {screen === "menu" ? "Press 'q' to quit" : "Press Escape to go back"}
        </Text>
      </Box>
    </Box>
  );
}
