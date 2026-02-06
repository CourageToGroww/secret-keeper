import React from "react";
import { Box, Text } from "ink";
import { RotationConfig, SecretMetadata } from "../../types";

interface StatusDashboardProps {
  secrets: SecretMetadata[];
  rotationConfigs: RotationConfig[];
  onBack: () => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isOverdue(nextRotation: string | null): boolean {
  if (!nextRotation) return false;
  return new Date(nextRotation) <= new Date();
}

function daysUntil(nextRotation: string | null): number | null {
  if (!nextRotation) return null;
  const diff = new Date(nextRotation).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export function StatusDashboard({
  secrets,
  rotationConfigs,
  onBack,
}: StatusDashboardProps): React.ReactElement {
  // Build a map for quick lookup
  const configMap = new Map(rotationConfigs.map((c) => [c.secretName, c]));

  // Separate secrets with and without rotation
  const withRotation = secrets.filter((s) => configMap.has(s.name));
  const withoutRotation = secrets.filter((s) => !configMap.has(s.name));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Rotation Status Dashboard
        </Text>
      </Box>

      {withRotation.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold underline>
            Secrets with Rotation
          </Text>
          <Box marginTop={1} flexDirection="column">
            {/* Header */}
            <Box>
              <Box width={25}>
                <Text bold>Secret</Text>
              </Box>
              <Box width={12}>
                <Text bold>Provider</Text>
              </Box>
              <Box width={10}>
                <Text bold>Status</Text>
              </Box>
              <Box width={10}>
                <Text bold>Days</Text>
              </Box>
              <Box width={20}>
                <Text bold>Next Rotation</Text>
              </Box>
            </Box>

            {/* Rows */}
            {withRotation.map((secret) => {
              const config = configMap.get(secret.name)!;
              const overdue = isOverdue(config.nextRotation);
              const days = daysUntil(config.nextRotation);

              return (
                <Box key={secret.name}>
                  <Box width={25}>
                    <Text>{secret.name.substring(0, 23)}</Text>
                  </Box>
                  <Box width={12}>
                    <Text>{config.providerType}</Text>
                  </Box>
                  <Box width={10}>
                    {config.enabled ? (
                      overdue ? (
                        <Text color="red">OVERDUE</Text>
                      ) : (
                        <Text color="green">Active</Text>
                      )
                    ) : (
                      <Text color="yellow">Disabled</Text>
                    )}
                  </Box>
                  <Box width={10}>
                    <Text color={overdue ? "red" : days !== null && days <= 7 ? "yellow" : undefined}>
                      {days !== null ? `${days}d` : "-"}
                    </Text>
                  </Box>
                  <Box width={20}>
                    <Text dimColor>{formatDate(config.nextRotation)}</Text>
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {withoutRotation.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold underline>
            Secrets without Rotation
          </Text>
          <Box marginTop={1} flexDirection="column">
            {withoutRotation.map((secret) => (
              <Text key={secret.name} dimColor>
                • {secret.name}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {secrets.length === 0 && (
        <Text dimColor>No secrets found. Add some with 'secret-keeper add'.</Text>
      )}

      <Box marginTop={1}>
        <Text dimColor>Press 'q' or Escape to go back</Text>
      </Box>
    </Box>
  );
}
