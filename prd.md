# Agent-VM: NullClaw Web Terminal (PoC)

> A web-based terminal that spawns isolated NullClaw AI agent sessions on demand. Users get instant access to a fully autonomous AI assistant in a sandboxed Linux microVM with zero setup.

---

## 1. Problem Statement

Running an AI coding agent today requires local installation, dependency management, and trusting the agent with your host filesystem. There is no way to "try NullClaw in 2 seconds" from a browser. This project solves that by pairing NullClaw's tiny footprint (678 KB, <2 ms startup) with Deno Sandbox's instant microVMs to deliver a hosted terminal experience.

---

## 2. Success Criteria

| Criteria | Target |
|---|---|
| User opens terminal in browser | Landing page → active session in one click |
| Session boot time | < 2 seconds (snapshot-backed) |
| NullClaw responds to input | User types, NullClaw processes and replies |
| Output streams in real-time | No polling; SSE push to xterm.js |
| Session auto-cleanup | 30 min TTL, server-side teardown |
| Concurrent sessions | At least 5 simultaneous users (Deno Sandbox default limit) |
| Cost per session | ~$0.08 for 30 minutes |

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  React SPA                                             │  │
│  │  ┌──────────────┐  ┌─────────────────────────────────┐│  │
│  │  │ Landing Page │→ │ xterm.js Terminal                ││  │
│  │  │ "Start"      │  │ - renders ANSI output           ││  │
│  │  │  button      │  │ - captures keystrokes           ││  │
│  │  └──────────────┘  │ - receives SSE stream           ││  │
│  │                     └─────────────────────────────────┘│  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTPS
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    Agent-VM Server (Bun + Hono)              │
│                                                              │
│  POST /api/sessions          → spawn sandbox, return id      │
│  GET  /api/sessions/:id/stream → SSE stream (stdout/stderr)  │
│  POST /api/sessions/:id/input  → write stdin to sandbox PTY  │
│  DELETE /api/sessions/:id      → kill sandbox                │
│  GET  /api/sessions/:id/status → health/metadata             │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ SessionManager                                       │    │
│  │ - Map<sessionId, SandboxHandle>                      │    │
│  │ - TTL watchdog (30 min auto-kill)                    │    │
│  │ - max concurrent session enforcement                 │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────┬───────────────────────────────┘
                               │ Deno Sandbox SDK (@deno/sandbox)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│              Deno Sandbox (Firecracker microVM)               │
│                                                              │
│  Root: NULLCLAW_SNAPSHOT (debian-13 + nullclaw binary)       │
│  Region: ord (Chicago)                                       │
│  Memory: 768 MB                                              │
│  Timeout: 30m                                                │
│  Network: allowNet for LLM API host only                     │
│                                                              │
│  Process: /usr/local/bin/nullclaw (interactive PTY)          │
│  - 678 KB static binary                                     │
│  - libc only, no runtime dependencies                        │
│  - < 2 ms cold start                                        │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | React + xterm.js | Industry-standard terminal emulation in the browser |
| Backend | Bun + Hono | Fast startup, native TS, lightweight HTTP framework |
| Sandbox | Deno Sandbox (Firecracker microVMs) | Sub-second boot from snapshots, API-driven lifecycle |
| Agent | NullClaw (Zig, 678 KB) | Smallest known AI agent binary; <2 ms startup, ~1 MB RAM |
| Streaming | SSE (Server-Sent Events) | Simple, HTTP-native, no WebSocket complexity for PoC |
| Build | Vite | Fast React builds, HMR for dev |

### Why NullClaw over alternatives

| Metric | NullClaw | OpenCode | Typical Node agent |
|---|---|---|---|
| Binary size | 678 KB | ~28 MB | >100 MB (with node_modules) |
| RAM usage | ~1 MB | >1 GB | >500 MB |
| Startup time | <2 ms | >500 ms | >2 s |
| Dependencies | None (libc only) | Node.js + npm | Node.js + npm + many packages |

NullClaw's profile makes it uniquely suited for ephemeral sandboxed sessions where boot time and resource cost per session matter.

---

## 5. Environment & Configuration

```bash
# Required - obtain from console.deno.com
DENO_DEPLOY_TOKEN=deno_dp_xxx...

# Snapshot slug created during Phase 0
NULLCLAW_SNAPSHOT=nullclaw-snapshot

# Region for sandbox creation
DENO_REGION=ord

# LLM provider credentials (injected into sandbox via Deno secrets)
LLM_API_KEY=sk-...
LLM_API_HOST=api.anthropic.com

# Server config
PORT=3000
MAX_CONCURRENT_SESSIONS=5
SESSION_TTL_MINUTES=30
```

---

## 6. Project Plan

### Phase 0: NullClaw Snapshot (0.5 day)

**Goal:** Create a reusable Deno Sandbox snapshot with NullClaw pre-installed so sessions boot in <1 second.

#### Tasks

| # | Task | Details |
|---|---|---|
| 0.1 | Create snapshot provisioning script | `scripts/create-snapshot.ts` using `@deno/sandbox` SDK |
| 0.2 | Create bootable volume | `client.volumes.create({ from: "builtin:debian-13", slug: "nullclaw-build", region: "ord", capacity: "2GB" })` |
| 0.3 | Boot sandbox from volume | `client.sandboxes.create({ region: "ord", root: "nullclaw-build" })` |
| 0.4 | Install NullClaw binary | `sandbox.sh\`curl -fsSL <nullclaw-release-url> -o /usr/local/bin/nullclaw && chmod +x /usr/local/bin/nullclaw\`` |
| 0.5 | Verify binary works | `sandbox.sh\`/usr/local/bin/nullclaw --version\`` |
| 0.6 | Create snapshot | `client.volumes.snapshot(volume.id, { slug: "nullclaw-snapshot" })` |
| 0.7 | Test snapshot boot | Boot new sandbox from snapshot, confirm nullclaw runs |
| 0.8 | Clean up build volume | `client.volumes.delete("nullclaw-build")` |

#### Deliverable
- `scripts/create-snapshot.ts` - idempotent script to create/update the snapshot
- Verified snapshot slug: `nullclaw-snapshot`

---

### Phase 1: Backend API (1 day)

**Goal:** Bun + Hono server that manages sandbox lifecycle and bridges terminal I/O between browser and NullClaw process.

#### Directory Structure

```
server/
├── src/
│   ├── index.ts              # Hono app entry, routes
│   ├── routes/
│   │   └── sessions.ts       # Session CRUD + streaming routes
│   ├── services/
│   │   ├── session-manager.ts # Sandbox lifecycle, TTL, concurrency
│   │   └── sandbox.ts        # Deno Sandbox SDK wrapper
│   ├── types.ts              # Shared types
│   └── config.ts             # Env parsing & validation
├── package.json
├── tsconfig.json
└── .env
```

#### API Endpoints

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| `POST` | `/api/sessions` | Create new session | `{}` | `{ id, status, createdAt }` |
| `GET` | `/api/sessions/:id/stream` | SSE stream of stdout/stderr | - | `text/event-stream` |
| `POST` | `/api/sessions/:id/input` | Send keystrokes to PTY | `{ data: string }` | `{ ok: true }` |
| `DELETE` | `/api/sessions/:id` | Kill session | - | `{ ok: true }` |
| `GET` | `/api/sessions/:id/status` | Session health check | - | `{ id, status, uptime, ... }` |

#### Tasks

| # | Task | Details |
|---|---|---|
| 1.1 | Initialize Bun project | `bun init`, install `hono`, `@deno/sandbox`, `nanoid` |
| 1.2 | Config module | Parse env vars, validate required tokens |
| 1.3 | Sandbox wrapper | Thin abstraction over `@deno/sandbox` SDK: `createSandbox()`, `spawnNullClaw()`, `writeStdin()`, `onStdout()`, `kill()` |
| 1.4 | Session manager | `Map<string, Session>` with create/get/delete/list. TTL timer per session (30 min). Concurrency limit (5). Cleanup on server shutdown (graceful `SIGTERM`). |
| 1.5 | POST /api/sessions | Call session manager, spawn sandbox from snapshot, start NullClaw process, return session metadata |
| 1.6 | GET /api/sessions/:id/stream | Open SSE connection. Pipe sandbox stdout/stderr as `data:` events. Send `event: status` for lifecycle changes. Handle client disconnect → keep session alive (reconnectable). |
| 1.7 | POST /api/sessions/:id/input | Validate session exists. Write `data` string to sandbox PTY stdin. |
| 1.8 | DELETE /api/sessions/:id | Kill sandbox, remove from session map, close SSE connections. |
| 1.9 | GET /api/sessions/:id/status | Return session metadata: id, status, createdAt, uptime. |
| 1.10 | Error handling middleware | Consistent error responses `{ error: string, code: number }`. Log errors server-side. |
| 1.11 | CORS middleware | Allow frontend origin in dev and prod. |
| 1.12 | Health endpoint | `GET /health` → `{ ok: true, sessions: count }` |

#### SSE Event Format

```
event: stdout
data: {"text": "NullClaw v0.1.0 ready\n"}

event: stderr  
data: {"text": "warning: ...\n"}

event: status
data: {"status": "running", "uptime": 12345}

event: exit
data: {"code": 0}
```

#### Key Design Decisions

1. **SSE over WebSocket** - Simpler for PoC. Unidirectional server→client push is sufficient since input goes via POST. Can upgrade to WebSocket in v2 if bidirectional framing helps.
2. **Session survives disconnect** - If the browser tab closes, the sandbox keeps running until TTL. User can reconnect via session ID (stored in localStorage).
3. **No auth for PoC** - Rate limiting by IP only. Auth is a Phase 4+ concern.

#### Deliverable
- Working API server that can spawn sandboxes, stream output, accept input
- Manual test: `curl` to create session, stream output, send input

---

### Phase 2: Frontend Terminal (0.5 day)

**Goal:** React SPA with xterm.js that connects to the backend and renders a full terminal experience.

#### Directory Structure

```
client/
├── src/
│   ├── main.tsx              # React entry
│   ├── App.tsx               # Router, layout
│   ├── components/
│   │   ├── Terminal.tsx       # xterm.js wrapper
│   │   ├── Landing.tsx       # Start button, branding
│   │   └── StatusBar.tsx     # Session info, kill button
│   ├── hooks/
│   │   ├── useSession.ts     # Session create/delete lifecycle
│   │   └── useTerminal.ts    # xterm.js + SSE + input wiring
│   ├── lib/
│   │   └── api.ts            # Fetch wrappers for backend
│   └── styles/
│       └── terminal.css      # Terminal and layout styles
├── index.html
├── vite.config.ts
├── package.json
└── tsconfig.json
```

#### Tasks

| # | Task | Details |
|---|---|---|
| 2.1 | Initialize Vite + React project | `bun create vite client --template react-ts` |
| 2.2 | Install dependencies | `xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links` |
| 2.3 | API client module | `createSession()`, `sendInput(id, data)`, `deleteSession(id)`, `getStatus(id)`, `streamUrl(id)` |
| 2.4 | Landing component | Minimal page: project name, one-line description, "Start Session" button. Check localStorage for existing session ID → offer "Reconnect". |
| 2.5 | Terminal component | Mount xterm.js instance. Configure: `fontFamily: "JetBrains Mono, monospace"`, `fontSize: 14`, `theme: dark`. Use `FitAddon` for responsive sizing. |
| 2.6 | useSession hook | `createSession()` → store ID in state + localStorage. `deleteSession()` → clear. Handle errors (capacity full, server down). |
| 2.7 | useTerminal hook | Connect EventSource to SSE endpoint. Parse `stdout`/`stderr`/`status`/`exit` events. Write text to xterm.js terminal. On `exit` event, show message + disable input. |
| 2.8 | Terminal input handling | `terminal.onData(data => sendInput(sessionId, data))`. Debounce not needed (keystrokes are small). Handle paste events. |
| 2.9 | StatusBar component | Show: session ID (truncated), uptime, "Kill Session" button. |
| 2.10 | Responsive layout | Terminal fills viewport. Fit addon recalculates on resize. Mobile: readable but input may be limited (acceptable for PoC). |
| 2.11 | Error states | "Connecting...", "Session ended", "Server unavailable", "Capacity full (try again later)". |
| 2.12 | Vite proxy config | Dev proxy `/api` → `http://localhost:3000` for local development. |

#### Deliverable
- React app that creates a session, renders terminal, streams output, accepts input
- Works in Chrome/Firefox/Safari

---

### Phase 3: End-to-End Integration (0.5 day)

**Goal:** Wire everything together, verify the full flow works, fix integration issues.

#### Tasks

| # | Task | Details |
|---|---|---|
| 3.1 | Integration test script | Script that: creates session via API, sends input, verifies output streams back, kills session. |
| 3.2 | Frontend ↔ Backend test | Start both servers, open browser, click Start, type command, verify NullClaw responds. |
| 3.3 | SSE reconnection | Close browser tab, reopen, verify reconnect to existing session works. |
| 3.4 | TTL verification | Create session, wait (or set short TTL for testing), verify auto-cleanup fires. |
| 3.5 | Concurrent sessions | Open 3+ tabs, verify each gets independent session. |
| 3.6 | Error path testing | Test: server down during session, sandbox crash, network interruption. Verify graceful degradation. |
| 3.7 | Fix integration bugs | Address any issues found in 3.1-3.6. |

#### Deliverable
- Full working flow: browser → backend → sandbox → NullClaw → streaming output → browser
- All success criteria verified

---

### Phase 4: Polish (0.5 day)

**Goal:** Production-readiness for demo/showcase purposes.

#### Tasks

| # | Task | Details |
|---|---|---|
| 4.1 | Loading states | Spinner/skeleton during sandbox boot. Progress indicator: "Creating sandbox..." → "Starting NullClaw..." → "Ready". |
| 4.2 | Terminal theming | Dark theme, NullClaw branding colors. Welcome message banner in terminal on connect. |
| 4.3 | Rate limiting | Basic IP-based rate limit on session creation (e.g., 3 sessions per IP per hour). |
| 4.4 | Graceful shutdown | Server `SIGTERM` handler: kill all active sandboxes, close SSE connections, drain HTTP. |
| 4.5 | Logging | Structured JSON logs: session create/destroy, errors, sandbox lifecycle events. |
| 4.6 | Static asset serving | Hono serves built React app in production (single deploy). |
| 4.7 | Docker / deploy config | Dockerfile for the Bun server + built frontend. Or deploy instructions for target platform. |
| 4.8 | README | Setup instructions, architecture diagram, env var docs, development workflow. |

#### Deliverable
- Polished, demo-ready application
- One-command local dev setup
- Deploy-ready artifact

---

## 7. Data Flow: Session Lifecycle

```
1. User clicks "Start Session"
   Browser → POST /api/sessions
   
2. Server creates sandbox
   Server → Deno SDK → Sandbox.create({ root: "nullclaw-snapshot", region: "ord", timeout: "30m", allowNet: ["api.anthropic.com"], secrets: { LLM_API_KEY: { hosts: ["api.anthropic.com"], value: env.LLM_API_KEY } } })
   
3. Server starts NullClaw in sandbox PTY
   Server → sandbox.spawn("/usr/local/bin/nullclaw", { tty: true })
   
4. Server returns session ID
   Server → Browser: { id: "abc123", status: "running" }
   
5. Browser opens SSE stream
   Browser → GET /api/sessions/abc123/stream
   Server pipes sandbox stdout/stderr → SSE events
   
6. User types in terminal
   Browser → POST /api/sessions/abc123/input { data: "hello\n" }
   Server → sandbox PTY stdin
   
7. NullClaw processes + responds
   Sandbox stdout → Server → SSE event → Browser → xterm.js renders
   
8. Session ends (user kills or TTL expires)
   Server → sandbox.kill()
   Server → SSE event: { event: "exit", data: { code: 0 } }
   Server removes session from map
```

---

## 8. Deno Sandbox Configuration

```typescript
// Sandbox creation config for each session
const sandbox = await Sandbox.create({
  // Boot from pre-built snapshot with NullClaw installed
  root: config.NULLCLAW_SNAPSHOT,
  
  // Region must match snapshot region
  region: config.DENO_REGION, // "ord"
  
  // Minimal memory - NullClaw only needs ~1 MB
  // but leave room for the OS + any file operations
  memoryMb: 768,
  
  // Auto-terminate after 30 minutes
  timeout: "30m",
  
  // Only allow outbound to the LLM API
  allowNet: [config.LLM_API_HOST],
  
  // Inject API key securely (never enters sandbox env)
  secrets: {
    LLM_API_KEY: {
      hosts: [config.LLM_API_HOST],
      value: config.LLM_API_KEY,
    },
  },
  
  // Metadata for dashboard tracking
  labels: {
    app: "nullclaw-web-terminal",
    version: "0.1.0",
  },
});
```

---

## 9. Snapshot Workflow

```
Step 1: Create bootable volume from debian-13 base
        ↓
Step 2: Boot sandbox with volume as writable root
        ↓
Step 3: curl NullClaw binary → /usr/local/bin/nullclaw
        chmod +x
        ↓
Step 4: (Optional) Pre-warm: run nullclaw --version
        ↓
Step 5: Snapshot the volume → "nullclaw-snapshot"
        ↓
Step 6: All future sessions boot from snapshot
        (read-only root, ephemeral writes, <1s boot)
```

---

## 10. Risk & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Deno Sandbox SDK doesn't support PTY/interactive stdin | Blocks entire project | Test PTY support in Phase 0. Fallback: use `sandbox.sh` with line-buffered I/O. |
| 5 concurrent sandbox limit | Limits demo capacity | Contact deploy@deno.com for higher limit. Implement queue for overflow. |
| NullClaw binary not available for sandbox arch (x86_64 Linux) | Blocks Phase 0 | Verify binary availability before starting. Build from source if needed. |
| SSE connection drops on mobile/unstable networks | Poor UX | Implement auto-reconnect with exponential backoff in frontend. |
| LLM API costs at scale | Budget overrun | Session TTL enforced server-side. Rate limit session creation per IP. |
| Sandbox boot time exceeds 2s target | Missed success criteria | Snapshot approach should guarantee <1s. Monitor and optimize. |

---

## 11. Future Considerations (Post-PoC)

These are explicitly **out of scope** for the 3-day PoC but worth noting:

- **Authentication** - GitHub OAuth or API keys for persistent user identity
- **WebSocket upgrade** - Replace SSE + POST input with single bidirectional WebSocket
- **Session persistence** - Save/restore NullClaw conversation state across sessions using volumes
- **File browser** - View/edit files NullClaw creates in the sandbox
- **Usage dashboard** - Track session count, duration, cost per user
- **Custom models** - Let users configure their own LLM API keys
- **Regions** - Let users pick `ord` or `ams` based on latency
- **Collaborative sessions** - Multiple users watching/interacting with same sandbox

---

## 12. Timeline Summary

| Phase | Duration | Key Output |
|---|---|---|
| **Phase 0: Snapshot** | 0.5 day | `nullclaw-snapshot` on Deno Sandbox, provisioning script |
| **Phase 1: Backend** | 1 day | Bun + Hono server with session management + SSE streaming |
| **Phase 2: Frontend** | 0.5 day | React + xterm.js terminal UI |
| **Phase 3: Integration** | 0.5 day | E2E verification, bug fixes |
| **Phase 4: Polish** | 0.5 day | Loading states, logging, deploy config |
| **Total** | **3 days** | **Working PoC** |

---

## 13. Cost Estimate

| Resource | Unit Cost | Per Session (30 min) |
|---|---|---|
| Deno Sandbox (768 MB, 2 vCPU) | ~$0.05 | $0.05 |
| LLM API calls | ~$0.01-0.03 per interaction | $0.03 (est. 3 interactions) |
| **Total** | | **~$0.08** |

At 100 sessions/day: ~$8/day, ~$240/month.
