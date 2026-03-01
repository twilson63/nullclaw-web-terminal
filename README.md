# NullClaw Web Terminal

A web-based terminal that spawns isolated [NullClaw](https://nullclaw.com) AI agent sessions on demand. Users get instant access to a fully autonomous AI assistant in a sandboxed Linux microVM -- no local setup required.

**Live demo:** https://nullclaw-web-terminal-production.up.railway.app

## How it works

1. User clicks "Start Session" in the browser
2. Server provisions a [Deno Sandbox](https://docs.deno.com/deploy/api/sandbox/) Firecracker microVM from a pre-built snapshot
3. NullClaw is onboarded and launched inside the VM
4. Terminal I/O streams in real-time via SSE to an xterm.js frontend

```
Browser (React + xterm.js)
    │ HTTPS
    ▼
Server (Node.js + Hono)
    │ @deno/sandbox SDK
    ▼
Firecracker microVM (Debian 13 + NullClaw)
```

## Architecture

- **Frontend:** React 19, xterm.js 5, Vite 6 -- landing page, terminal emulator, status bar
- **Backend:** Hono on Node.js (via tsx), session management, SSE streaming
- **Sandbox:** Deno Sandbox (Firecracker microVMs), snapshot-backed boot, 768 MB RAM, 30 min TTL
- **LLM:** OpenRouter (configurable model, defaults to Claude Sonnet)

## Project structure

```
├── client/                   # React SPA
│   └── src/
│       ├── App.tsx           # State machine: landing → connecting → terminal
│       ├── components/       # Landing, Terminal, StatusBar
│       ├── hooks/            # useSession, useTerminal
│       └── lib/api.ts        # Typed fetch wrappers
├── server/                   # API server
│   └── src/
│       ├── index.ts          # Hono app entry
│       ├── routes/sessions.ts  # REST + SSE endpoints
│       └── services/
│           ├── sandbox.ts         # Deno SDK wrapper, NullClaw onboarding
│           └── session-manager.ts # TTL watchdog, concurrency, cleanup
├── scripts/
│   └── create-snapshot.ts    # Snapshot provisioning script
├── railway.toml              # Railway deployment config
└── prd.md                    # Full project plan
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/sessions` | Create a new sandbox session |
| `GET` | `/api/sessions/:id/stream` | SSE stream of terminal output |
| `POST` | `/api/sessions/:id/input` | Send keystrokes to the sandbox |
| `DELETE` | `/api/sessions/:id` | Kill a session |
| `GET` | `/api/sessions/:id/status` | Session health and metadata |
| `GET` | `/health` | Server health check |

## Local development

### Prerequisites

- Node.js >= 20
- A [Deno Deploy](https://console.deno.com) account and token
- An [OpenRouter](https://openrouter.ai) API key
- A pre-built NullClaw snapshot (see `scripts/create-snapshot.ts`)

### Setup

```bash
# Clone the repo
git clone https://github.com/twilson63/nullclaw-web-terminal.git
cd nullclaw-web-terminal

# Configure environment
cp server/.env.example server/.env
# Edit server/.env with your DENO_DEPLOY_TOKEN and LLM_API_KEY

# Install dependencies
cd client && npm install && cd ../server && npm install && cd ..

# Run in development mode (server with hot-reload)
npm run dev
```

The dev server starts on `http://localhost:3000`. The Vite dev server proxies `/api` requests automatically.

### Production build

```bash
npm run build   # Builds client + installs server deps
npm start       # Starts the production server
```

## Deployment (Railway)

The project is configured for Railway with `railway.toml`. Railway auto-deploys on push to `main`.

Required environment variables on Railway:
- `DENO_DEPLOY_TOKEN`
- `NULLCLAW_SNAPSHOT`
- `LLM_API_KEY`
- `LLM_API_HOST` (default: `openrouter.ai`)
- `LLM_PROVIDER` (default: `openrouter`)
- `LLM_MODEL` (default: `anthropic/claude-sonnet-4`)

## Key technical decisions

- **Node.js over Bun:** Bun's WebSocket implementation doesn't support the `ws` library upgrade handshake that `@deno/sandbox` requires.
- **SSE over WebSocket:** Simpler to implement server→client streaming; input goes via POST.
- **Local echo in xterm.js:** The Deno Sandbox SDK has no PTY mode (`stdin: "piped"` only), so keystroke echo is handled client-side.
- **curl for web search:** NullClaw's built-in HTTP tools use Zig's TLS, which can't negotiate post-quantum cipher suites (`X25519MLKEM768`). SOUL.md directs the agent to use `curl` (OpenSSL) instead.
- **Scoped secret hosts:** The `LLM_API_KEY` secret is scoped to `openrouter.ai` only. Using wildcard `["*"]` causes Deno's secrets proxy to MITM all TLS, which breaks Zig's TLS implementation.

## License

MIT
