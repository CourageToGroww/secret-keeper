import React from "react";
import { Box, Text, useInput } from "ink";
import { AuditEntry } from "../../types";

interface AuditLogProps {
  entries: AuditEntry[];
  onBack: () => void;
}

function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").split(".")[0];
}

function getActionColor(action: string): string {
  if (action.includes("ADDED") || action.includes("UNLOCKED")) return "green";
  if (action.includes("DELETED") || action.includes("LOCKED")) return "red";
  if (action.includes("CHANGED")) return "yellow";
  return "white";
}

function getActionEmoji(action: string): string {
  switch (action) {
    case "VAULT_INITIALIZED":
      return "🆕";
    case "VAULT_UNLOCKED":
      return "🔓";
    case "VAULT_LOCKED":
      return "🔒";
    case "SECRET_ADDED":
      return "➕";
    case "SECRET_DELETED":
      return "🗑️";
    case "SECRETS_EXPORTED":
      return "📤";
    case "PASSWORD_CHANGED":
      return "🔑";
    default:
      return "📋";
  }
}

export function AuditLog({ entries, onBack }: AuditLogProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "q") {
      onBack();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Audit Log
      </Text>

      {entries.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No audit entries found.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {/* Header */}
          <Box>
            <Box width={20}>
              <Text bold>Timestamp</Text>
            </Box>
            <Box width={3}>
              <Text bold> </Text>
            </Box>
            <Box width={20}>
              <Text bold>Action</Text>
            </Box>
            <Box width={20}>
              <Text bold>Secret</Text>
            </Box>
          </Box>

          {/* Entries */}
          {entries.slice(0, 20).map((entry, i) => (
            <Box key={entry.id || i}>
              <Box width={20}>
                <Text dimColor>{formatTimestamp(entry.timestamp)}</Text>
              </Box>
              <Box width={3}>
                <Text>{getActionEmoji(entry.action)}</Text>
              </Box>
              <Box width={20}>
                <Text color={getActionColor(entry.action) as any}>
                  {entry.action.replace(/_/g, " ")}
                </Text>
              </Box>
              <Box width={20}>
                <Text>{entry.secretName || "-"}</Text>
              </Box>
            </Box>
          ))}

          {entries.length > 20 && (
            <Box marginTop={1}>
              <Text dimColor>Showing 20 of {entries.length} entries</Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Press 'q' or Escape to go back</Text>
      </Box>
    </Box>
  );
}
