import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { RotationHistoryEntry, SecretMetadata } from "../../types";

interface RotationHistoryProps {
  history: RotationHistoryEntry[];
  secrets: SecretMetadata[];
  onBack: () => void;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function RotationHistory({
  history,
  secrets,
  onBack,
}: RotationHistoryProps): React.ReactElement {
  const [filter, setFilter] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      if (filter) {
        setFilter(null);
      } else {
        onBack();
      }
    }
  });

  const filteredHistory = filter
    ? history.filter((h) => h.secretName === filter)
    : history;

  const secretNames = [...new Set(history.map((h) => h.secretName))];

  if (!filter && secretNames.length > 1) {
    const items = [
      { label: "📋 All History", value: "all" },
      ...secretNames.map((name) => ({ label: `📁 ${name}`, value: name })),
      { label: "← Back", value: "back" },
    ];

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Rotation History
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "back") {
                onBack();
              } else if (item.value === "all") {
                setFilter(null);
                // We'll show history directly
              } else {
                setFilter(item.value);
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Rotation History{filter ? `: ${filter}` : ""}
        </Text>
      </Box>

      {filteredHistory.length === 0 ? (
        <Text dimColor>No rotation history found.</Text>
      ) : (
        <Box flexDirection="column">
          {/* Header */}
          <Box>
            <Box width={20}>
              <Text bold>Timestamp</Text>
            </Box>
            <Box width={25}>
              <Text bold>Secret</Text>
            </Box>
            <Box width={12}>
              <Text bold>Provider</Text>
            </Box>
            <Box width={10}>
              <Text bold>Status</Text>
            </Box>
          </Box>

          {/* Rows */}
          {filteredHistory.slice(0, 20).map((entry) => (
            <Box key={entry.id}>
              <Box width={20}>
                <Text dimColor>{formatTimestamp(entry.timestamp)}</Text>
              </Box>
              <Box width={25}>
                <Text>{entry.secretName.substring(0, 23)}</Text>
              </Box>
              <Box width={12}>
                <Text>{entry.providerType}</Text>
              </Box>
              <Box width={10}>
                {entry.status === "success" ? (
                  <Text color="green">✓ OK</Text>
                ) : (
                  <Text color="red">✗ FAIL</Text>
                )}
              </Box>
            </Box>
          ))}

          {/* Show error details for failures */}
          {filteredHistory.slice(0, 20).filter((e) => e.errorMessage).length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color="red">
                Errors:
              </Text>
              {filteredHistory
                .slice(0, 20)
                .filter((e) => e.errorMessage)
                .map((entry) => (
                  <Text key={entry.id} dimColor>
                    [{entry.secretName}] {entry.errorMessage?.substring(0, 60)}...
                  </Text>
                ))}
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
