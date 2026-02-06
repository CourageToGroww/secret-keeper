import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { RotationConfig, RotationResult } from "../../types";

interface RotationListProps {
  configs: RotationConfig[];
  onRotateNow: (secretName: string) => Promise<RotationResult>;
  onToggle: (secretName: string, enabled: boolean) => void;
  onDelete: (secretName: string) => void;
  onTest: (secretName: string) => Promise<{ success: boolean; error?: string }>;
  onBack: () => void;
  onAddNew?: () => void;
}

type ActionType = "rotate" | "toggle" | "delete" | "test" | "back" | "add";

interface ListItem {
  label: string;
  value: string;
  config?: RotationConfig;
  action?: ActionType;
}

export function RotationList({
  configs,
  onRotateNow,
  onToggle,
  onDelete,
  onTest,
  onBack,
  onAddNew,
}: RotationListProps): React.ReactElement {
  const [selectedConfig, setSelectedConfig] = useState<RotationConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      if (selectedConfig) {
        setSelectedConfig(null);
      } else {
        onBack();
      }
    }
  });

  const handleSelect = async (item: ListItem) => {
    if (item.action === "add") {
      if (onAddNew) {
        onAddNew();
      }
      return;
    }

    if (item.action === "back") {
      if (selectedConfig) {
        setSelectedConfig(null);
      } else {
        onBack();
      }
      return;
    }

    if (item.config && !selectedConfig) {
      setSelectedConfig(item.config);
      return;
    }

    if (!selectedConfig) return;

    setMessage(null);

    switch (item.action) {
      case "rotate":
        setIsLoading(true);
        try {
          const result = await onRotateNow(selectedConfig.secretName);
          if (result.success) {
            setMessage({ text: "Rotation successful!", color: "green" });
          } else {
            setMessage({ text: `Rotation failed: ${result.error}`, color: "red" });
          }
        } catch (error) {
          setMessage({ text: `Error: ${error}`, color: "red" });
        }
        setIsLoading(false);
        break;

      case "toggle":
        onToggle(selectedConfig.secretName, !selectedConfig.enabled);
        setSelectedConfig(null);
        break;

      case "delete":
        onDelete(selectedConfig.secretName);
        setSelectedConfig(null);
        break;

      case "test":
        setIsLoading(true);
        try {
          const result = await onTest(selectedConfig.secretName);
          if (result.success) {
            setMessage({ text: "Test passed!", color: "green" });
          } else {
            setMessage({ text: `Test failed: ${result.error}`, color: "red" });
          }
        } catch (error) {
          setMessage({ text: `Error: ${error}`, color: "red" });
        }
        setIsLoading(false);
        break;
    }
  };

  if (configs.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Rotation Configurations
        </Text>
        <Box marginTop={1}>
          <Text dimColor>No rotation configurations found.</Text>
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={[
              ...(onAddNew ? [{ label: "➕ Add New Rotation", value: "add" }] : []),
              { label: "← Back", value: "back" },
            ]}
            onSelect={(item) => {
              if (item.value === "add" && onAddNew) {
                onAddNew();
              } else {
                onBack();
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (selectedConfig) {
    const actions: ListItem[] = [
      { label: "🔄 Rotate Now", value: "rotate", action: "rotate" },
      { label: "🧪 Test Rotation", value: "test", action: "test" },
      {
        label: selectedConfig.enabled ? "⏸️  Disable Rotation" : "▶️  Enable Rotation",
        value: "toggle",
        action: "toggle",
      },
      { label: "🗑️  Delete Configuration", value: "delete", action: "delete" },
      { label: "← Back", value: "back", action: "back" },
    ];

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          {selectedConfig.secretName}
        </Text>

        <Box marginY={1} flexDirection="column">
          <Text>
            Provider: <Text color="yellow">{selectedConfig.providerType}</Text>
          </Text>
          <Text>
            Schedule: <Text color="yellow">Every {selectedConfig.scheduleDays} days</Text>
          </Text>
          <Text>
            Status:{" "}
            {selectedConfig.enabled ? (
              <Text color="green">Enabled</Text>
            ) : (
              <Text color="red">Disabled</Text>
            )}
          </Text>
          <Text>
            Last Rotated:{" "}
            <Text dimColor>
              {selectedConfig.lastRotated
                ? new Date(selectedConfig.lastRotated).toLocaleString()
                : "Never"}
            </Text>
          </Text>
          <Text>
            Next Rotation:{" "}
            <Text dimColor>
              {selectedConfig.nextRotation
                ? new Date(selectedConfig.nextRotation).toLocaleString()
                : "N/A"}
            </Text>
          </Text>
        </Box>

        {isLoading ? (
          <Box>
            <Text color="green">
              <Spinner type="dots" />
            </Text>
            <Text> Processing...</Text>
          </Box>
        ) : message ? (
          <Box marginY={1}>
            <Text color={message.color as any}>{message.text}</Text>
          </Box>
        ) : (
          <SelectInput items={actions} onSelect={handleSelect} />
        )}
      </Box>
    );
  }

  const items: ListItem[] = [
    ...(onAddNew ? [{ label: "➕ Add New Rotation", value: "add", action: "add" as const }] : []),
    ...configs.map((config) => ({
      label: `${config.enabled ? "✓" : "○"} ${config.secretName} (${config.providerType}, ${config.scheduleDays}d)`,
      value: config.secretName,
      config,
    })),
    { label: "← Back", value: "back", action: "back" as const },
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Rotation Configurations
      </Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={handleSelect} />
      </Box>
    </Box>
  );
}
