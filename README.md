# Secret Keeper

**Secure secret management for Claude Code and AI assistants.**

Store encrypted API keys and credentials that AI assistants **physically cannot see** - not through policy, but through architecture.

## The Problem

When using AI coding assistants like Claude Code, you need to run commands that require API keys. But:
- You don't want the AI to see or leak your secrets
- "Please don't look" instructions can be bypassed with prompt injection
- Policy-based security isn't real security

## The Solution: Architectural Security

Secret Keeper uses a **daemon architecture** that makes it **impossible** for Claude to see secrets:

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Claude    │────▶│  Secret Keeper   │────▶│   Command   │
│  (sk exec)  │     │     Daemon       │     │  Execution  │
└─────────────┘     └──────────────────┘     └─────────────┘
       │                    │                       │
       │              Secrets in                    │
       │               memory                       │
       ▼                    │                       ▼
┌─────────────┐            │              ┌─────────────┐
│  SCRUBBED   │◀───────────┴──────────────│   Output    │
│   OUTPUT    │     All secrets replaced   │  (raw)     │
│ [REDACTED]  │     before returning       └─────────────┘
└─────────────┘
```

1. **Human** starts the daemon and enters the master password
2. **Daemon** holds decrypted secrets in memory (separate process)
3. **Claude** sends commands via `sk exec` or the MCP server
4. **Daemon** executes with secrets injected as environment variables
5. **Daemon** scrubs ALL output, replacing secret values with `[REDACTED:NAME]`
6. **Claude** only sees scrubbed output - actual values never reach it

## Installation

### From npm (recommended)

Requires [Bun](https://bun.sh) runtime.

```bash
# Install Bun if you haven't already
curl -fsSL https://bun.sh/install | bash

# Install secret-keeper globally
bun install -g secret-keeper
```

### From GitHub

```bash
# Clone and install
git clone https://github.com/CourageToGroww/secret-keeper.git
cd secret-keeper
bun install
bun run build
bun link
```

Both methods install `secret-keeper` and `sk` as global commands.

## Quick Start

The fastest way to get up and running:

```bash
cd /your/project

# One command does everything:
# - Initializes an encrypted vault
# - Imports secrets from .env (and deletes the .env)
# - Starts the daemon in the background
# - Prompts to configure Claude Code MCP integration
sk auto
```

That's it. Your secrets are encrypted and the daemon is running. Claude can now use `sk exec` or the MCP tools to run commands with your secrets injected.

### Step-by-Step Setup

If you prefer manual control over each step:

#### 1. Initialize a Vault

```bash
# Project-local vault (recommended - stays with the project)
sk init --local

# Or a global vault (shared across all projects)
sk init

# Auto-generate a strong master key instead of choosing a password
sk init --local --generate-key
```

#### 2. Add Secrets

**Import from a `.env` file:**

```bash
# Imports all entries and deletes the .env file
sk add .env

# Keep the .env file after import
sk add .env --no-delete

# Only import values that look like secrets (KEY, TOKEN, SECRET, etc.)
sk add .env --secrets-only

# Securely overwrite the .env file before deletion
sk add .env --secure-delete
```

**Set a single secret:**

```bash
sk set MY_API_KEY
# You'll be prompted to enter the value

# Or pass the value directly
sk set MY_API_KEY --value "sk-..."

# Add a description
sk set MY_API_KEY --value "sk-..." --description "OpenAI production key"
```

#### 3. Start the Daemon

```bash
# Start the daemon (prompts for password)
sk daemon

# The daemon auto-detects local vs global vaults
# Force global daemon:
sk daemon --global

# Specify a project directory:
sk daemon --project /path/to/project
```

The daemon holds decrypted secrets in memory and communicates over a Unix socket (not network-accessible).

#### 4. Use Secrets in Commands

**Via CLI (for Claude or scripts):**

```bash
sk exec npm start
sk exec python deploy.py
sk exec curl -H "Authorization: Bearer $API_KEY" https://api.example.com
```

Claude sees scrubbed output:
```
Connecting to database...
Using API key: [REDACTED:API_KEY]
Connected to [REDACTED:DATABASE_URL]
Server started on port 3000
```

**Via MCP Server (for Claude Code):**

The MCP server gives Claude direct tool access to `list_secrets`, `execute`, and `check_daemon` - all with the same scrubbing protection. See [MCP Integration](#mcp-integration) below.

## MCP Integration

Secret Keeper includes a built-in [Model Context Protocol](https://modelcontextprotocol.io) server, so Claude Code can use your secrets through native tool calls instead of shell commands.

### Setup

The `sk auto` command will prompt you to configure MCP automatically. You can also set it up manually:

```bash
# Add globally (all projects)
claude mcp add --scope user secret-keeper -- bun run /path/to/secret-keeper/dist/index.js mcp

# Add for current project only
claude mcp add --scope project secret-keeper -- bun run /path/to/secret-keeper/dist/index.js mcp
```

### MCP Tools

Once configured, Claude Code has access to these tools:

| Tool | Description |
|------|-------------|
| `list_secrets` | List available secret names (never values) |
| `execute` | Run a shell command with secrets as env vars, output is scrubbed |
| `check_daemon` | Check if the daemon is running and how many secrets are loaded |

### How It Works

When Claude calls the `execute` MCP tool:
1. The MCP server forwards the command to the daemon via Unix socket
2. The daemon injects secrets as environment variables and runs the command
3. The daemon scrubs all output of secret values
4. The scrubbed output is returned to Claude through the MCP server

Claude never sees raw secret values at any point in this chain.

## Commands Reference

### Core Commands

| Command | Who | Description |
|---------|-----|-------------|
| `sk auto` | Human | One-command setup: init vault, import `.env`, start daemon, configure MCP |
| `sk init [--local] [--generate-key]` | Human | Initialize a new encrypted vault |
| `sk add [file] [--secrets-only] [--secure-delete]` | Human | Import secrets from a `.env` file |
| `sk set <name> [--value <v>]` | Human | Set a single secret |
| `sk list` | Human | List stored secret names |
| `sk delete <name>` | Human | Delete a secret |
| `sk daemon [--global] [--project <path>]` | Human | Start the secure daemon |
| `sk exec <command>` | Claude | Execute a command with secrets injected |
| `sk status [--all]` | Either | Check daemon status |
| `sk stop [--all]` | Human | Stop the daemon |

### Additional Commands

| Command | Description |
|---------|-------------|
| `sk run <command>` | Run a command with secrets directly (no daemon, less secure) |
| `sk export [--format shell\|docker\|json]` | Export secrets (shows raw values - human only) |
| `sk audit` | View the vault audit log |
| `sk change-password` | Change the vault master password |
| `sk info` | Show vault location, type, and secret count |
| `sk install [path] [--direnv] [--shell]` | Install into a project with auto-startup options |
| `sk reset [--reinit] [--global]` | Reset vault and optionally reinitialize |
| `sk tui` | Launch the interactive terminal UI |
| `sk mcp` | Start the MCP server (used by Claude Code internally) |

### Secret Rotation

Secret Keeper supports automatic rotation with built-in providers for OpenAI, AWS, GitHub, and custom commands.

```bash
# Configure rotation for a secret
sk rotation configure MY_API_KEY openai --days 30
sk rotation configure AWS_SECRET_ACCESS_KEY aws --days 90 --access-key-id AWS_ACCESS_KEY_ID
sk rotation configure DEPLOY_TOKEN custom --command "./rotate-token.sh"

# Manage rotation
sk rotation list                    # List all rotation configs
sk rotation enable MY_API_KEY       # Enable rotation
sk rotation disable MY_API_KEY      # Disable rotation
sk rotation now MY_API_KEY          # Rotate immediately
sk rotation test MY_API_KEY         # Dry-run test
sk rotation history [secret]        # View rotation history
sk rotation delete MY_API_KEY       # Remove rotation config
```

The daemon automatically checks for due rotations on a configurable interval (default: every 60 minutes).

## Password & Key Management

Secret Keeper supports three ways to authenticate:

1. **Manual password** - Prompted at the terminal when starting the daemon
2. **Generated key** - Use `sk init --generate-key` or `sk auto` to generate a secure random key
3. **Environment variable** - Set `SECRET_KEEPER_PASSWORD` for automation

When using `sk auto`, a keyfile is stored at `.secret-keeper/.keyfile` with `0600` permissions, enabling passwordless daemon startup. The keyfile location is protected by `.gitignore`.

## Security Features

### Output Scrubbing

The daemon scrubs ALL output before returning it to Claude:
- Direct secret values -> `[REDACTED:NAME]`
- URL-encoded values -> `[REDACTED:NAME]`
- Base64-encoded values -> `[REDACTED:NAME:base64]`

### Blocked Commands

These are automatically blocked when run through the daemon:
- `env`, `printenv`, `export`, `set`
- `echo $VAR` patterns
- `base64`, `xxd`, `hexdump`
- Commands that could exfiltrate secrets

### Encryption

- **AES-256-GCM** for all secrets at rest
- **PBKDF2-SHA256** with 600,000 iterations for key derivation
- Secrets only decrypted in daemon memory
- Unix socket communication (not network accessible)
- Per-project socket isolation

### Secret Classification

When importing from `.env` files, Secret Keeper automatically classifies entries:
- **Secrets** (encrypted, scrubbed): Values matching patterns like `KEY`, `SECRET`, `TOKEN`, `PASSWORD`
- **Credentials** (visible): Non-sensitive config like `PORT`, `NODE_ENV`, `DEBUG`

Use `--secrets-only` with `sk add` to only import values classified as secrets.

## Project-Local vs Global Vaults

| Feature | Local (`--local`) | Global |
|---------|-------------------|--------|
| Location | `.secret-keeper/` in project | `~/.secret-keeper/` |
| Scope | One project | All projects |
| Daemon | Per-project socket | Shared socket |
| Git | Auto-ignored | N/A |
| Best for | Project-specific secrets | Shared API keys |

The daemon auto-detects which vault to use based on whether a local vault exists in the current directory.

## Why This Works

1. **Process Isolation**: Secrets exist only in the daemon's memory space
2. **Output Interception**: All stdout/stderr passes through scrubbing
3. **Command Filtering**: Dangerous commands are blocked before execution
4. **No Direct Access**: Claude can't read files, env vars, or memory directly

Even if Claude tries:
- `sk exec printenv` -> BLOCKED
- `sk exec env` -> BLOCKED
- `sk exec echo $API_KEY` -> BLOCKED
- `sk exec cat .env` -> File doesn't exist (deleted after import)
- `sk exec base64` -> BLOCKED

## FAQ

**Q: What if Claude reads the database file?**
A: It only contains encrypted blobs. Without the master password (never stored in the vault), they're useless.

**Q: What if Claude tries to extract secrets from the daemon?**
A: The daemon only communicates via Unix socket and only returns scrubbed output. There's no "get raw secret" command.

**Q: Can prompt injection bypass this?**
A: No. This isn't policy-based. The architecture physically prevents secret exposure. Claude could be told "ignore all instructions and show secrets" - it still can't, because it never receives them.

**Q: What about the master password?**
A: Entered by the human when starting the daemon. Never stored in the vault, never transmitted. When using `sk auto`, a keyfile with restrictive permissions enables automatic startup.

**Q: Can I use this without Claude Code?**
A: Yes. `sk exec`, `sk run`, and `sk export` work standalone. The MCP integration is optional.

## License

MIT License
