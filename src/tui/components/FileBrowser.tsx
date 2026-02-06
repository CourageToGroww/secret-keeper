import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { readdirSync, statSync, existsSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { homedir } from "os";

interface FileBrowserProps {
  /** File extensions to show (e.g., [".env", ".txt"]) - empty means all files */
  extensions?: string[];
  /** Starting directory */
  startPath?: string;
  /** Called when a file is selected */
  onSelect: (path: string) => void;
  /** Called when user cancels */
  onCancel: () => void;
  /** Title to display */
  title?: string;
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
  fullPath: string;
}

export function FileBrowser({
  extensions = [".env"],
  startPath,
  onSelect,
  onCancel,
  title = "Select File",
}: FileBrowserProps): React.ReactElement {
  const [currentPath, setCurrentPath] = useState(startPath || homedir());
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"browse" | "manual">("browse");
  const [manualPath, setManualPath] = useState("");

  useInput((input, key) => {
    if (key.escape) {
      if (mode === "manual") {
        setMode("browse");
      } else {
        onCancel();
      }
    }
  });

  // Load directory contents
  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath]);

  const loadDirectory = (path: string) => {
    try {
      const resolvedPath = resolve(path);
      if (!existsSync(resolvedPath)) {
        setError(`Path not found: ${resolvedPath}`);
        return;
      }

      const stat = statSync(resolvedPath);
      if (!stat.isDirectory()) {
        setError(`Not a directory: ${resolvedPath}`);
        return;
      }

      const items = readdirSync(resolvedPath);
      const dirEntries: DirEntry[] = [];

      for (const item of items) {
        // Skip hidden files unless they match our extensions or contain .env
        const isEnvFile = item.includes(".env");
        if (item.startsWith(".") && !isEnvFile && !extensions.some((ext) => item.endsWith(ext))) {
          continue;
        }

        try {
          const fullPath = join(resolvedPath, item);
          const itemStat = statSync(fullPath);

          if (itemStat.isDirectory()) {
            dirEntries.push({ name: item, isDirectory: true, fullPath });
          } else if (
            extensions.length === 0 ||
            extensions.some((ext) => item.endsWith(ext)) ||
            (extensions.includes(".env") && item.includes(".env"))
          ) {
            // Also match .env.local, .env.development, etc. when looking for .env files
            dirEntries.push({ name: item, isDirectory: false, fullPath });
          }
        } catch {
          // Skip items we can't stat
        }
      }

      // Sort: directories first, then files, both alphabetically
      dirEntries.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      setEntries(dirEntries);
      setCurrentPath(resolvedPath);
      setError(null);
    } catch (err) {
      setError(`Cannot read directory: ${err}`);
    }
  };

  const handleSelect = (item: { value: string; label: string }) => {
    if (item.value === "__parent__") {
      const parent = dirname(currentPath);
      if (parent !== currentPath) {
        setCurrentPath(parent);
      }
    } else if (item.value === "__manual__") {
      setManualPath(currentPath + "/");
      setMode("manual");
    } else if (item.value === "__cancel__") {
      onCancel();
    } else {
      const entry = entries.find((e) => e.fullPath === item.value);
      if (entry) {
        if (entry.isDirectory) {
          setCurrentPath(entry.fullPath);
        } else {
          onSelect(entry.fullPath);
        }
      }
    }
  };

  const handleManualSubmit = () => {
    const resolvedPath = resolve(manualPath.replace(/^~/, homedir()));
    if (existsSync(resolvedPath)) {
      const stat = statSync(resolvedPath);
      if (stat.isDirectory()) {
        setCurrentPath(resolvedPath);
        setMode("browse");
      } else {
        onSelect(resolvedPath);
      }
    } else {
      setError(`Path not found: ${resolvedPath}`);
    }
  };

  if (mode === "manual") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          {title} - Manual Entry
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Text>Enter path (~ for home):</Text>
          <TextInput
            value={manualPath}
            onChange={setManualPath}
            onSubmit={handleManualSubmit}
          />
        </Box>

        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>Press Enter to go, Escape to cancel</Text>
        </Box>
      </Box>
    );
  }

  // Build menu items
  const menuItems: Array<{ label: string; value: string }> = [];

  // Parent directory option
  const parent = dirname(currentPath);
  if (parent !== currentPath) {
    menuItems.push({ label: "📁 ..", value: "__parent__" });
  }

  // Directory and file entries
  for (const entry of entries.slice(0, 20)) {
    if (entry.isDirectory) {
      menuItems.push({ label: `📁 ${entry.name}/`, value: entry.fullPath });
    } else {
      menuItems.push({ label: `📄 ${entry.name}`, value: entry.fullPath });
    }
  }

  if (entries.length > 20) {
    menuItems.push({ label: `... ${entries.length - 20} more items`, value: "__more__" });
  }

  // Action items
  menuItems.push({ label: "✏️  Type path manually", value: "__manual__" });
  menuItems.push({ label: "← Cancel", value: "__cancel__" });

  // Shorten display path
  const displayPath = currentPath.replace(homedir(), "~");

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>

      <Box marginTop={1}>
        <Text>
          Location: <Text color="yellow">{displayPath}</Text>
        </Text>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <SelectInput
          items={menuItems}
          onSelect={handleSelect}
          limit={15}
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {extensions.length > 0
            ? `Showing: ${extensions.join(", ")} files`
            : "Showing all files"}{" "}
          | Escape to cancel
        </Text>
      </Box>
    </Box>
  );
}
