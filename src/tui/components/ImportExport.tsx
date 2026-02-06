import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { readFileSync } from "fs";
import { ExportFormat } from "../../types";
import { FileBrowser } from "./FileBrowser";

interface ImportExportProps {
  secrets: Record<string, string>;
  onImportEntry: (name: string, value: string, sensitive: boolean) => Promise<void>;
  onDelete?: (name: string) => Promise<void>;
  onBack: () => void;
}

interface ParsedEntry {
  name: string;
  value: string;
  sensitive: boolean;  // user-controlled
}

type Screen = "menu" | "import" | "categorize" | "export";

// Heuristics to detect likely secrets
const SECRET_PATTERNS = [
  /key/i, /secret/i, /password/i, /passwd/i, /token/i, /auth/i,
  /credential/i, /private/i, /api_key/i, /apikey/i, /bearer/i,
  /jwt/i, /cert/i, /encryption/i,
];

function isLikelySecret(name: string, value: string): boolean {
  // Check name patterns
  if (SECRET_PATTERNS.some((p) => p.test(name))) return true;
  // Long random-looking strings are likely secrets
  if (value.length > 20 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return true;
  // Values starting with sk-, pk-, etc.
  if (/^(sk|pk|api|key|token|secret)[-_]/i.test(value)) return true;
  return false;
}

function parseEnvContent(content: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      const [, name, rawValue] = match;
      // Remove quotes if present
      let value = rawValue;
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      entries.push({
        name,
        value,
        sensitive: isLikelySecret(name, value),
      });
    }
  }

  return entries;
}

function maskValue(value: string): string {
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }
  return value.substring(0, 2) + "*".repeat(Math.min(value.length - 4, 16)) + value.substring(value.length - 2);
}

export function ImportExport({
  secrets,
  onImportEntry,
  onDelete,
  onBack,
}: ImportExportProps): React.ReactElement {
  const [screen, setScreen] = useState<Screen>("menu");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("shell");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);
  const [exportOutput, setExportOutput] = useState<string | null>(null);
  const [parsedEntries, setParsedEntries] = useState<ParsedEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      if (screen === "menu") {
        onBack();
      } else if (screen === "export" || screen === "categorize") {
        setScreen("menu");
        setMessage(null);
        setExportOutput(null);
        setParsedEntries([]);
      }
    }
  });

  const handleFileSelected = (filePath: string) => {
    try {
      const content = readFileSync(filePath, "utf-8");
      const entries = parseEnvContent(content);

      if (entries.length === 0) {
        setMessage({ text: "No valid entries found in file", color: "red" });
        setScreen("menu");
        return;
      }

      setParsedEntries(entries);
      setSelectedIndex(0);
      setMessage({
        text: `Found ${entries.length} entries in ${filePath.split("/").pop()}`,
        color: "cyan",
      });
      setScreen("categorize");
    } catch (error) {
      setMessage({ text: `Failed to read file: ${error}`, color: "red" });
      setScreen("menu");
    }
  };

  const toggleSensitive = (index: number) => {
    setParsedEntries((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], sensitive: !updated[index].sensitive };
      return updated;
    });
  };

  const removeEntry = (index: number) => {
    setParsedEntries((prev) => prev.filter((_, i) => i !== index));
  };

  const handleImportAll = async () => {
    setIsLoading(true);
    try {
      for (const entry of parsedEntries) {
        await onImportEntry(entry.name, entry.value, entry.sensitive);
      }
      setMessage({
        text: `Imported ${parsedEntries.length} entries (${parsedEntries.filter(e => e.sensitive).length} secrets, ${parsedEntries.filter(e => !e.sensitive).length} credentials)`,
        color: "green",
      });
      setParsedEntries([]);
      setScreen("menu");
    } catch (error) {
      setMessage({ text: `Import failed: ${error}`, color: "red" });
    }
    setIsLoading(false);
  };

  const handleExport = () => {
    let output = "";
    const entries = Object.entries(secrets);

    switch (exportFormat) {
      case "shell":
        output = entries
          .map(([name, value]) => {
            const escaped = value.replace(/'/g, "'\\''");
            return `export ${name}='${escaped}'`;
          })
          .join("\n");
        break;

      case "docker":
        output = entries.map(([name, value]) => `-e ${name}=${value}`).join("\n");
        break;

      case "json":
        output = JSON.stringify(secrets, null, 2);
        break;
    }

    setExportOutput(output);
  };

  if (isLoading) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text color="green">
            <Spinner type="dots" />
          </Text>
          <Text> Processing...</Text>
        </Box>
      </Box>
    );
  }

  if (screen === "import") {
    return (
      <FileBrowser
        title="Import from .env File"
        extensions={[".env"]}
        onSelect={handleFileSelected}
        onCancel={() => setScreen("menu")}
      />
    );
  }

  if (screen === "categorize") {
    const secretCount = parsedEntries.filter((e) => e.sensitive).length;
    const credentialCount = parsedEntries.length - secretCount;

    // Build menu items
    const menuItems = parsedEntries.map((entry, index) => ({
      label: entry.sensitive
        ? `🔒 ${entry.name.substring(0, 20).padEnd(20)} = ${maskValue(entry.value).substring(0, 25)}`
        : `📝 ${entry.name.substring(0, 20).padEnd(20)} = ${entry.value.substring(0, 25)}${entry.value.length > 25 ? "..." : ""}`,
      value: `toggle:${index}`,
    }));

    menuItems.push(
      { label: "─────────────────────────────────", value: "__sep__" },
      { label: `✓ Import All (${parsedEntries.length} entries)`, value: "__import__" },
      { label: "← Cancel", value: "__cancel__" }
    );

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Categorize Entries
        </Text>

        {message && (
          <Box marginY={1}>
            <Text color={message.color as any}>{message.text}</Text>
          </Box>
        )}

        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text>
            🔒 <Text color="yellow">Secrets</Text>: {secretCount} (encrypted & masked)
          </Text>
          <Text>
            📝 <Text color="cyan">Credentials</Text>: {credentialCount} (stored but visible)
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Select an entry to toggle between Secret/Credential:</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <SelectInput
            items={menuItems}
            limit={12}
            onSelect={(item) => {
              if (item.value === "__import__") {
                handleImportAll();
              } else if (item.value === "__cancel__" || item.value === "__sep__") {
                if (item.value === "__cancel__") {
                  setScreen("menu");
                  setParsedEntries([]);
                }
              } else if (item.value.startsWith("toggle:")) {
                const index = parseInt(item.value.split(":")[1], 10);
                toggleSensitive(index);
              }
            }}
          />
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            🔒 = Secret (masked) | 📝 = Credential (visible) | Press Escape to cancel
          </Text>
        </Box>
      </Box>
    );
  }

  if (screen === "export") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Export Secrets
        </Text>

        <Box marginTop={1}>
          <Text bold color="red">
            ⚠️  WARNING: This shows actual secret values!
          </Text>
        </Box>

        {!exportOutput ? (
          <>
            <Box marginTop={1} flexDirection="column">
              <Text>Select export format:</Text>
              <SelectInput
                items={[
                  { label: "Shell (export VAR='value')", value: "shell" },
                  { label: "Docker (-e VAR=value)", value: "docker" },
                  { label: "JSON", value: "json" },
                ]}
                onSelect={(item) => {
                  setExportFormat(item.value as ExportFormat);
                  handleExport();
                }}
              />
            </Box>
          </>
        ) : (
          <>
            <Box
              marginTop={1}
              flexDirection="column"
              borderStyle="single"
              borderColor="yellow"
              paddingX={1}
              height={15}
              overflow="hidden"
            >
              {exportOutput.split("\n").slice(0, 12).map((line, i) => (
                <Text key={i}>{line}</Text>
              ))}
              {exportOutput.split("\n").length > 12 && (
                <Text dimColor>... ({exportOutput.split("\n").length - 12} more lines)</Text>
              )}
            </Box>

            <Box marginTop={1}>
              <Text dimColor>
                Copy the above output. Press Escape to go back.
              </Text>
            </Box>
          </>
        )}

        <Box marginTop={1}>
          <Text dimColor>Press Escape to go back</Text>
        </Box>
      </Box>
    );
  }

  // Menu screen
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Import / Export
      </Text>

      {message && (
        <Box marginY={1}>
          <Text color={message.color as any}>{message.text}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: "📥 Import from .env file", value: "import" },
            { label: "📤 Export secrets", value: "export" },
            { label: "← Back", value: "back" },
          ]}
          onSelect={(item) => {
            setMessage(null);
            if (item.value === "import") {
              setScreen("import");
            } else if (item.value === "export") {
              setScreen("export");
              setExportOutput(null);
            } else {
              onBack();
            }
          }}
        />
      </Box>
    </Box>
  );
}
