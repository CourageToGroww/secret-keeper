/**
 * MCP Server for Secret Keeper
 *
 * This server allows Claude to execute commands with secrets WITHOUT
 * ever seeing the actual secret values. The daemon handles:
 * 1. Injecting secrets as environment variables
 * 2. Scrubbing any leaked secrets from output
 *
 * SECURITY: This server intentionally does NOT expose any way to
 * retrieve actual secret values. Claude only sees secret names.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "./daemon";
import { findProjectSocketPath, DEFAULT_SOCKET_PATH, getProjectSocketPath } from "./types";

/**
 * Get the appropriate daemon client for a given working directory.
 * This enables per-project daemon isolation.
 */
function getClientForCwd(cwd?: string): DaemonClient {
  const targetCwd = cwd || process.cwd();
  const socketPath = findProjectSocketPath(targetCwd);
  return new DaemonClient(socketPath);
}

const TOOLS: Tool[] = [
  {
    name: "list_secrets",
    description:
      "List the names of available secrets. Returns only names, NOT values. Use these names with the execute tool.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "execute",
    description: `Execute a shell command with secrets available as environment variables.

IMPORTANT: You will NEVER see the actual secret values. The daemon:
1. Injects secrets as environment variables (e.g., $OPENAI_API_KEY)
2. Runs your command
3. Scrubs any accidentally leaked secrets from the output

Use secret names from list_secrets as environment variables in your command.

Example: execute("curl -H 'Authorization: Bearer $OPENAI_API_KEY' https://api.openai.com/v1/models")`,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute. Reference secrets as $SECRET_NAME",
        },
        cwd: {
          type: "string",
          description: "Working directory (optional)",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 300)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "check_daemon",
    description: "Check if the secret-keeper daemon is running and how many secrets are loaded.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

async function main() {
  // Default client for the MCP server's cwd (for list_secrets/check_daemon)
  // Execute commands will dynamically create clients based on their cwd

  const server = new Server(
    {
      name: "secret-keeper",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "list_secrets": {
          const client = getClientForCwd();
          const socketPath = findProjectSocketPath();
          const isProject = socketPath !== DEFAULT_SOCKET_PATH;

          if (!client.isRunning()) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Secret-keeper daemon is not running${isProject ? " (project)" : ""}. Start it with 'secret-keeper daemon' or via the TUI.`,
                },
              ],
              isError: true,
            };
          }

          const secrets = await client.listSecrets();
          const daemonType = isProject ? " (project daemon)" : " (global daemon)";
          return {
            content: [
              {
                type: "text",
                text: secrets.length > 0
                  ? `Available secrets${daemonType} (${secrets.length}):\n${secrets.map(s => `  - ${s}`).join("\n")}\n\nUse these as environment variables with the execute tool, e.g., $${secrets[0] || "SECRET_NAME"}`
                  : `No secrets available${daemonType}. Add secrets via the TUI or CLI.`,
              },
            ],
          };
        }

        case "execute": {
          const command = args?.command as string;
          const cwd = args?.cwd as string | undefined;
          const timeout = (args?.timeout as number) || 300;

          // Get client based on the command's cwd
          const targetCwd = cwd || process.cwd();
          const client = getClientForCwd(targetCwd);
          const socketPath = findProjectSocketPath(targetCwd);
          const isProject = socketPath !== DEFAULT_SOCKET_PATH;

          if (!client.isRunning()) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Secret-keeper daemon is not running${isProject ? " (project)" : ""}. Start it with 'secret-keeper daemon' or via the TUI.`,
                },
              ],
              isError: true,
            };
          }

          if (!command) {
            return {
              content: [{ type: "text", text: "Error: command is required" }],
              isError: true,
            };
          }

          const result = await client.execute(command, cwd, timeout);

          if (result.blocked) {
            return {
              content: [
                {
                  type: "text",
                  text: `Command blocked: ${result.blockReason}`,
                },
              ],
              isError: true,
            };
          }

          let output = "";
          if (result.stdout) {
            output += result.stdout;
          }
          if (result.stderr) {
            output += (output ? "\n\nSTDERR:\n" : "STDERR:\n") + result.stderr;
          }
          if (!output) {
            output = "(no output)";
          }

          output += `\n\n[Exit code: ${result.exitCode}]`;

          return {
            content: [{ type: "text", text: output }],
            isError: result.exitCode !== 0,
          };
        }

        case "check_daemon": {
          const client = getClientForCwd();
          const socketPath = findProjectSocketPath();
          const isProject = socketPath !== DEFAULT_SOCKET_PATH;
          const daemonType = isProject ? "Project" : "Global";

          if (!client.isRunning()) {
            return {
              content: [
                {
                  type: "text",
                  text: `${daemonType} daemon status: NOT RUNNING\nSocket: ${socketPath}\n\nStart the daemon with:\n  secret-keeper daemon\n\nOr use the TUI:\n  secret-keeper tui`,
                },
              ],
            };
          }

          try {
            const ping = await client.ping();
            const secrets = await client.listSecrets();
            return {
              content: [
                {
                  type: "text",
                  text: `${daemonType} daemon status: RUNNING\nSocket: ${socketPath}\nSecrets loaded: ${ping.secretsLoaded}\nAvailable: ${secrets.join(", ") || "(none)"}`,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `${daemonType} daemon status: ERROR\nSocket: ${socketPath}\n${error}`,
                },
              ],
              isError: true,
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP Server error:", error);
  process.exit(1);
});
