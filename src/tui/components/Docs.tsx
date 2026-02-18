import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";

type DocSection =
  | "overview"
  | "automated"
  | "secrets"
  | "daemon"
  | "rotation"
  | "reset"
  | "cli"
  | "mcp"
  | "security";

interface DocsProps {
  onBack: () => void;
}

const SECTIONS = [
  { label: "Overview", value: "overview" },
  { label: "What's Automated", value: "automated" },
  { label: "Managing Secrets", value: "secrets" },
  { label: "Daemon Control", value: "daemon" },
  { label: "Secret Rotation", value: "rotation" },
  { label: "Reset & Recovery", value: "reset" },
  { label: "CLI Commands", value: "cli" },
  { label: "MCP Integration", value: "mcp" },
  { label: "Security Model", value: "security" },
  { label: "Back to Menu", value: "back" },
];

export function Docs({ onBack }: DocsProps): React.ReactElement {
  const [section, setSection] = useState<DocSection | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      if (section) {
        setSection(null);
      } else {
        onBack();
      }
    }
  });

  const renderContent = () => {
    switch (section) {
      case "overview":
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="cyan">Overview</Text>
            <Box marginTop={1} flexDirection="column">
              <Text>
                Secret Keeper is a secure secret management tool designed for
                developers and AI assistants like Claude.
              </Text>
              <Text> </Text>
              <Text bold>Key Features:</Text>
              <Text>  • Encrypted vault storage (AES-256-GCM)</Text>
              <Text>  • Per-project isolation with separate daemons</Text>
              <Text>  • Automatic secret scrubbing from command output</Text>
              <Text>  • Shell integration for automatic daemon startup</Text>
              <Text>  • MCP server for Claude Code integration</Text>
              <Text>  • Automatic secret rotation scheduling</Text>
              <Text> </Text>
              <Text bold>How It Works:</Text>
              <Text>  1. Secrets are stored encrypted in a SQLite database</Text>
              <Text>  2. A daemon process holds decrypted secrets in memory</Text>
              <Text>  3. Commands run via the daemon get secrets as env vars</Text>
              <Text>  4. Output is scrubbed to prevent accidental leaks</Text>
            </Box>
          </Box>
        );

      case "automated":
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="cyan">What's Automated</Text>
            <Box marginTop={1} flexDirection="column">
              <Text bold color="green">Fully Automatic:</Text>
              <Text> </Text>
              <Text>  • <Text bold>Daemon Startup</Text> - When you cd into a project with</Text>
              <Text>    a .secret-keeper folder and keyfile, the daemon starts</Text>
              <Text>    automatically (via shell integration in ~/.zshrc)</Text>
              <Text> </Text>
              <Text>  • <Text bold>Output Scrubbing</Text> - Any command run via 'sk exec'</Text>
              <Text>    has its output automatically scrubbed for secret values</Text>
              <Text>    (plain text, base64, URL-encoded)</Text>
              <Text> </Text>
              <Text>  • <Text bold>Secret Rotation</Text> - When enabled, secrets are</Text>
              <Text>    automatically rotated on schedule while daemon runs</Text>
              <Text> </Text>
              <Text>  • <Text bold>Vault Initialization</Text> - Running 'sk auto' in a new</Text>
              <Text>    project creates the vault with an auto-generated key</Text>
              <Text> </Text>
              <Text bold color="yellow">Semi-Automatic (requires setup once):</Text>
              <Text> </Text>
              <Text>  • <Text bold>Shell Integration</Text> - Add to ~/.zshrc once:</Text>
              <Text dimColor>    sk_auto() &#123; [ -d ".secret-keeper" ] && sk auto --local --quiet; &#125;</Text>
              <Text dimColor>    cd() &#123; builtin cd "$@" && sk_auto; &#125;</Text>
              <Text> </Text>
              <Text>  • <Text bold>Import Secrets</Text> - Run 'sk add .env' once per project</Text>
              <Text> </Text>
              <Text bold color="red">Manual (by design):</Text>
              <Text> </Text>
              <Text>  - <Text bold>Rotation Config</Text> - You must configure which</Text>
              <Text>    secrets to rotate and how often</Text>
            </Box>
          </Box>
        );

      case "secrets":
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="cyan">Managing Secrets</Text>
            <Box marginTop={1} flexDirection="column">
              <Text bold>Adding Secrets:</Text>
              <Text> </Text>
              <Text>  <Text bold>From .env file:</Text></Text>
              <Text dimColor>    sk add .env              # Import all from .env</Text>
              <Text dimColor>    sk add .env.local        # Or any .env variant</Text>
              <Text> </Text>
              <Text>  <Text bold>Single secret:</Text></Text>
              <Text dimColor>    sk set MY_KEY -v "value"  # Set with value</Text>
              <Text> </Text>
              <Text>  <Text bold>Via TUI:</Text></Text>
              <Text>    Import/Export → Browse to .env file → Import</Text>
              <Text> </Text>
              <Text bold>Secret Types:</Text>
              <Text> </Text>
              <Text>  • <Text color="red">Sensitive</Text> - Always masked (API keys, passwords)</Text>
              <Text>  • <Text color="green">Credential</Text> - Can be shown (URLs, usernames)</Text>
              <Text> </Text>
              <Text>  Auto-detected as sensitive: *KEY*, *SECRET*, *TOKEN*,</Text>
              <Text>  *PASSWORD*, *CREDENTIAL*, *PRIVATE*</Text>
              <Text> </Text>
              <Text bold>Using Secrets:</Text>
              <Text> </Text>
              <Text dimColor>    sk exec npm start                    # All secrets available</Text>
              <Text dimColor>    sk exec 'echo $MY_API_KEY'           # Reference by name</Text>
              <Text dimColor>    sk exec 'curl -H "Auth: $TOKEN" ...' # In commands</Text>
              <Text> </Text>
              <Text>  Secrets are injected as environment variables.</Text>
              <Text>  Output is scrubbed - leaked values show as [REDACTED:NAME]</Text>
            </Box>
          </Box>
        );

      case "daemon":
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="cyan">Daemon Control</Text>
            <Box marginTop={1} flexDirection="column">
              <Text bold>What is the Daemon?</Text>
              <Text> </Text>
              <Text>  The daemon is a background process that:</Text>
              <Text>  • Holds decrypted secrets in memory</Text>
              <Text>  • Executes commands with secrets as env vars</Text>
              <Text>  • Scrubs output to prevent leaks</Text>
              <Text>  • Runs rotation scheduler</Text>
              <Text> </Text>
              <Text bold>Per-Project Daemons:</Text>
              <Text> </Text>
              <Text>  Each project can have its own daemon with isolated secrets.</Text>
              <Text>  Socket paths: /tmp/secret-keeper/project-[hash].sock</Text>
              <Text>  Global daemon: /tmp/secret-keeper/sk.sock</Text>
              <Text> </Text>
              <Text bold>Starting the Daemon:</Text>
              <Text> </Text>
              <Text dimColor>    sk auto          # Auto-init + start (uses keyfile)</Text>
              <Text dimColor>    sk daemon        # Start daemon (uses keyfile)</Text>
              <Text dimColor>    sk daemon -g     # Force global daemon</Text>
              <Text> </Text>
              <Text bold>Managing Daemons:</Text>
              <Text> </Text>
              <Text dimColor>    sk status        # Check current project's daemon</Text>
              <Text dimColor>    sk status -a     # Check ALL running daemons</Text>
              <Text dimColor>    sk stop          # Stop current project's daemon</Text>
              <Text dimColor>    sk stop -a       # Stop ALL daemons</Text>
              <Text> </Text>
              <Text>  Or use TUI → Running Daemons to see and manage all.</Text>
            </Box>
          </Box>
        );

      case "rotation":
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="cyan">Secret Rotation</Text>
            <Box marginTop={1} flexDirection="column">
              <Text bold>What is Rotation?</Text>
              <Text> </Text>
              <Text>  Automatic periodic replacement of secrets for security.</Text>
              <Text>  The daemon checks for due rotations every hour (configurable).</Text>
              <Text> </Text>
              <Text bold>Supported Providers:</Text>
              <Text> </Text>
              <Text>  • <Text bold>OpenAI</Text> - Rotates API keys via OpenAI API</Text>
              <Text>  • <Text bold>AWS</Text> - Rotates IAM access keys</Text>
              <Text>  • <Text bold>GitHub</Text> - Rotates personal access tokens</Text>
              <Text>  • <Text bold>Custom</Text> - Run any command that outputs new value</Text>
              <Text> </Text>
              <Text bold>Configuring Rotation:</Text>
              <Text> </Text>
              <Text>  Via TUI: Configure Rotations → Add New</Text>
              <Text> </Text>
              <Text>  Via CLI:</Text>
              <Text dimColor>    sk rotation configure MY_KEY custom -d 30 -c "./rotate.sh"</Text>
              <Text dimColor>    sk rotation configure OPENAI_API_KEY openai -d 90</Text>
              <Text dimColor>    sk rotation enable MY_KEY</Text>
              <Text dimColor>    sk rotation disable MY_KEY</Text>
              <Text dimColor>    sk rotation now MY_KEY      # Rotate immediately</Text>
              <Text dimColor>    sk rotation test MY_KEY     # Dry run</Text>
              <Text> </Text>
              <Text bold>Rotation History:</Text>
              <Text> </Text>
              <Text>  View past rotations in TUI → Rotation History</Text>
              <Text>  Or: sk rotation history [secret-name]</Text>
            </Box>
          </Box>
        );

      case "reset":
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="cyan">Reset & Recovery</Text>
            <Box marginTop={1} flexDirection="column">
              <Text bold>When to Reset:</Text>
              <Text> </Text>
              <Text>  - Vault is corrupted or in a bad state</Text>
              <Text>  - Want to start fresh with new secrets</Text>
              <Text>  - Lost your keyfile</Text>
              <Text> </Text>
              <Text bold color="red">Warning:</Text>
              <Text color="red">  Reset permanently deletes ALL secrets and configs!</Text>
              <Text> </Text>
              <Text bold>Reset via TUI:</Text>
              <Text> </Text>
              <Text>  Vault Settings → Reset Vault</Text>
              <Text>  • <Text bold>Reset & Reinitialize</Text> - Deletes vault, creates new</Text>
              <Text>    one with generated key, starts daemon</Text>
              <Text>  • <Text bold>Reset Only</Text> - Just deletes the vault</Text>
              <Text> </Text>
              <Text bold>Reset via CLI:</Text>
              <Text> </Text>
              <Text dimColor>  sk reset              # Reset local vault (with confirmation)</Text>
              <Text dimColor>  sk reset -y           # Skip confirmation</Text>
              <Text dimColor>  sk reset --reinit     # Reset and reinitialize</Text>
              <Text dimColor>  sk reset -g           # Reset global vault</Text>
              <Text dimColor>  sk reset -g --reinit  # Reset and reinit global</Text>
              <Text> </Text>
              <Text bold>Recovery Options:</Text>
              <Text> </Text>
              <Text>  <Text bold>If you have the keyfile:</Text></Text>
              <Text>    The key is stored in .secret-keeper/.keyfile</Text>
              <Text>    Just run: sk auto</Text>
              <Text> </Text>
              <Text>  <Text bold>If vault was backed up:</Text></Text>
              <Text>    Restore .secret-keeper/ from backup</Text>
              <Text>    Include both secrets.db and .keyfile</Text>
              <Text> </Text>
              <Text bold>After Reset:</Text>
              <Text> </Text>
              <Text>  1. Note the new key is saved to .keyfile</Text>
              <Text>  2. Re-import your secrets: sk add .env</Text>
              <Text>  3. Reconfigure any rotation schedules</Text>
            </Box>
          </Box>
        );

      case "cli":
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="cyan">CLI Commands</Text>
            <Box marginTop={1} flexDirection="column">
              <Text bold>Setup:</Text>
              <Text dimColor>  sk init [--local]     Initialize vault</Text>
              <Text dimColor>  sk install [path]     Install into project</Text>
              <Text dimColor>  sk auto               Auto-init + start daemon</Text>
              <Text> </Text>
              <Text bold>Secrets:</Text>
              <Text dimColor>  sk add [.env]         Import from .env file</Text>
              <Text dimColor>  sk set NAME           Set single secret</Text>
              <Text dimColor>  sk list               List secret names</Text>
              <Text dimColor>  sk delete NAME        Delete a secret</Text>
              <Text dimColor>  sk export             Export (shows values!)</Text>
              <Text> </Text>
              <Text bold>Daemon:</Text>
              <Text dimColor>  sk daemon             Start daemon</Text>
              <Text dimColor>  sk status [-a]        Check daemon status</Text>
              <Text dimColor>  sk stop [-a]          Stop daemon</Text>
              <Text dimColor>  sk exec CMD           Run command with secrets</Text>
              <Text> </Text>
              <Text bold>Rotation:</Text>
              <Text dimColor>  sk rotation list      List rotation configs</Text>
              <Text dimColor>  sk rotation configure Configure rotation</Text>
              <Text dimColor>  sk rotation now NAME  Rotate immediately</Text>
              <Text dimColor>  sk rotation history   View rotation history</Text>
              <Text> </Text>
              <Text bold>Other:</Text>
              <Text dimColor>  sk tui                Launch this TUI</Text>
              <Text dimColor>  sk info               Show vault info</Text>
              <Text dimColor>  sk audit              Show audit log</Text>
              <Text dimColor>  sk reset [--reinit]   Reset vault completely</Text>
              <Text dimColor>  sk mcp                Start MCP server</Text>
            </Box>
          </Box>
        );

      case "mcp":
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="cyan">MCP Integration (Claude Code)</Text>
            <Box marginTop={1} flexDirection="column">
              <Text bold>What is MCP?</Text>
              <Text> </Text>
              <Text>  Model Context Protocol - allows Claude to use tools.</Text>
              <Text>  Secret Keeper provides an MCP server so Claude can</Text>
              <Text>  execute commands with secrets WITHOUT seeing the values.</Text>
              <Text> </Text>
              <Text bold>Security Model:</Text>
              <Text> </Text>
              <Text>  • Claude NEVER sees actual secret values</Text>
              <Text>  • Claude only sees secret names via list_secrets</Text>
              <Text>  • Commands run through the daemon with scrubbed output</Text>
              <Text>  • Dangerous commands are blocked (env, printenv, etc.)</Text>
              <Text> </Text>
              <Text bold>Setup:</Text>
              <Text> </Text>
              <Text>  Add to ~/.claude/.mcp.json:</Text>
              <Text dimColor>  &#123;</Text>
              <Text dimColor>    "mcpServers": &#123;</Text>
              <Text dimColor>      "secret-keeper": &#123;</Text>
              <Text dimColor>        "command": "bun",</Text>
              <Text dimColor>        "args": ["run", "/path/to/secret-keeper/src/index.ts", "mcp"]</Text>
              <Text dimColor>      &#125;</Text>
              <Text dimColor>    &#125;</Text>
              <Text dimColor>  &#125;</Text>
              <Text> </Text>
              <Text bold>Available Tools for Claude:</Text>
              <Text> </Text>
              <Text>  • <Text bold>list_secrets</Text> - Get names of available secrets</Text>
              <Text>  • <Text bold>execute</Text> - Run command with secrets as env vars</Text>
              <Text>  • <Text bold>check_daemon</Text> - Check if daemon is running</Text>
              <Text> </Text>
              <Text bold>Usage by Claude:</Text>
              <Text> </Text>
              <Text dimColor>  "Run npm start with the API keys"</Text>
              <Text dimColor>  → Claude calls execute("npm start")</Text>
              <Text dimColor>  → Daemon injects $API_KEY, scrubs output</Text>
              <Text dimColor>  → Claude sees result without secret values</Text>
            </Box>
          </Box>
        );

      case "security":
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="cyan">Security Model</Text>
            <Box marginTop={1} flexDirection="column">
              <Text bold>Encryption:</Text>
              <Text> </Text>
              <Text>  • AES-256-GCM for secret encryption</Text>
              <Text>  • PBKDF2 with 600,000 iterations for key derivation</Text>
              <Text>  • Unique salt and nonce per encryption</Text>
              <Text>  • Secrets only decrypted in daemon memory</Text>
              <Text> </Text>
              <Text bold>Output Scrubbing:</Text>
              <Text> </Text>
              <Text>  Commands run via 'sk exec' have output scrubbed for:</Text>
              <Text>  • Plain text secret values</Text>
              <Text>  • Base64-encoded values</Text>
              <Text>  • URL-encoded values</Text>
              <Text>  • Case-insensitive matching</Text>
              <Text> </Text>
              <Text bold>Command Blocking:</Text>
              <Text> </Text>
              <Text>  These commands are blocked to prevent secret extraction:</Text>
              <Text>  • env, printenv, export, set</Text>
              <Text>  • echo $VAR, printf with vars</Text>
              <Text>  • cat /proc/*/environ</Text>
              <Text>  • hexdump, xxd, od, base64</Text>
              <Text> </Text>
              <Text bold>File Permissions:</Text>
              <Text> </Text>
              <Text>  • Vault directory: 700 (owner only)</Text>
              <Text>  • Socket file: 600 (owner only)</Text>
              <Text>  • Keyfile: 600 (owner only)</Text>
              <Text> </Text>
              <Text bold>Best Practices:</Text>
              <Text> </Text>
              <Text>  • Use per-project vaults for isolation</Text>
              <Text>  • Add .secret-keeper to .gitignore</Text>
              <Text>  • Back up your keyfile securely</Text>
              <Text>  • Enable rotation for critical secrets</Text>
              <Text>  • Use 'sk exec' instead of 'sk run' for Claude</Text>
            </Box>
          </Box>
        );

      default:
        return null;
    }
  };

  // Section content view
  if (section) {
    return (
      <Box flexDirection="column">
        {renderContent()}
        <Box marginTop={2} paddingX={1}>
          <Text dimColor>Press Escape to go back</Text>
        </Box>
      </Box>
    );
  }

  // Main menu view
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Documentation
      </Text>
      <Text dimColor>Learn how to use Secret Keeper</Text>

      <Box marginTop={1}>
        <SelectInput
          items={SECTIONS}
          onSelect={(item) => {
            if (item.value === "back") {
              onBack();
            } else {
              setSection(item.value as DocSection);
            }
          }}
        />
      </Box>
    </Box>
  );
}
