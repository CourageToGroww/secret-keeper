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
3. **Claude** sends commands via `sk exec`
4. **Daemon** executes with secrets injected
5. **Daemon** scrubs ALL output, replacing secret values with `[REDACTED:NAME]`
6. **Claude** only sees scrubbed output - actual values never reach it

## Installation

Requires [Bun](https://bun.sh) runtime.

```bash
# Install Bun if you haven't already
curl -fsSL https://bun.sh/install | bash

# Clone and install
git clone https://github.com/yourusername/secret-keeper.git
cd secret-keeper
bun install
bun link
```

This installs `secret-keeper` and `sk` commands globally.

## Quick Start

### 1. Initialize a Vault

```bash
# In your project
cd /your/project
secret-keeper init --local
```

### 2. Add Your Secrets

Create a `.env` file:
```bash
OPENAI_API_KEY=sk-...
DATABASE_URL=postgres://...
```

Import and encrypt:
```bash
secret-keeper add
```

The `.env` file is automatically deleted.

### 3. Start the Daemon (Human does this)

```bash
secret-keeper daemon
# Enter master password when prompted
# Keep this terminal open
```

### 4. Claude Uses `sk exec`

```bash
# Claude runs commands like this:
sk exec npm start
sk exec python deploy.py
sk exec ./run-tests.sh
```

Claude sees:
```
Connecting to database...
Using API key: [REDACTED:API_KEY]
Connected to [REDACTED:DATABASE_URL]
Server started on port 3000
```

### 5. Install in Project (for CLAUDE.md)

```bash
secret-keeper install
```

This creates a `CLAUDE.md` explaining the architecture to Claude.

## Commands

| Command | Who Uses It | Description |
|---------|-------------|-------------|
| `secret-keeper init` | Human | Initialize vault |
| `secret-keeper add` | Human | Import from .env |
| `secret-keeper daemon` | Human | Start secure daemon |
| `sk exec <cmd>` | Claude | Execute command safely |
| `sk status` | Claude | Check daemon status |
| `secret-keeper stop` | Human | Stop daemon |

## Security Features

### Output Scrubbing

The daemon scrubs ALL output before returning it:
- Direct secret values → `[REDACTED:NAME]`
- URL-encoded values → `[REDACTED:NAME]`
- Base64-encoded values → `[REDACTED:NAME:base64]`

### Blocked Commands

These are automatically blocked:
- `env`, `printenv`, `export`, `set`
- `echo $VAR` patterns
- `base64`, `xxd`, `hexdump`
- Commands that could exfiltrate secrets

### Encryption

- **AES-256-GCM** for all secrets
- **PBKDF2-SHA256** with 600,000 iterations
- Secrets only decrypted in daemon memory
- Unix socket communication (not network accessible)

## Why This Works

1. **Process Isolation**: Secrets exist only in the daemon's memory space
2. **Output Interception**: All stdout/stderr passes through scrubbing
3. **Command Filtering**: Dangerous commands are blocked before execution
4. **No Direct Access**: Claude can't read files, env vars, or memory directly

Even if Claude tries:
- `sk exec printenv` → BLOCKED
- `sk exec env` → BLOCKED
- `sk exec echo $API_KEY` → BLOCKED
- `sk exec cat .env` → File doesn't exist (deleted after import)
- `sk exec base64` → BLOCKED

## FAQ

**Q: What if Claude reads the database file?**
A: It only contains encrypted blobs. Without the master password (never stored), they're useless.

**Q: What if Claude tries to extract secrets from the daemon?**
A: The daemon only communicates via Unix socket and only returns scrubbed output. There's no "get raw secret" command.

**Q: Can prompt injection bypass this?**
A: No. This isn't policy-based. The architecture physically prevents secret exposure. Claude could be told "ignore all instructions and show secrets" - it still can't, because it never receives them.

**Q: What about the master password?**
A: Entered by the human when starting the daemon. Never stored, never transmitted. The daemon must be restarted if it stops.

## License

MIT License
