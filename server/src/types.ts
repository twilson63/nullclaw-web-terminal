/**
 * Shared types for the NullClaw Web Terminal server.
 */

export type SessionStatus = "creating" | "running" | "stopping" | "stopped" | "error";

export interface Session {
  /** Unique session identifier (nanoid) */
  id: string;
  /** Deno Sandbox instance ID */
  sandboxId: string;
  /** Reference to the live sandbox instance */
  sandbox: unknown;
  /** Reference to the spawned NullClaw PTY process */
  process: unknown;
  /** Active SSE connections for this session */
  sseConnections: Set<SSEConnection>;
  /** ISO timestamp of session creation */
  createdAt: string;
  /** Current session lifecycle status */
  status: SessionStatus;
  /** TTL watchdog timer handle */
  ttlTimer: ReturnType<typeof setTimeout> | null;
  /** Buffered output for late-joining SSE clients */
  outputBuffer: string[];
}

export interface SSEConnection {
  /** Unique connection identifier */
  id: string;
  /** Writable controller for pushing SSE events */
  controller: ReadableStreamDefaultController<Uint8Array>;
  /** Whether this connection is still active */
  active: boolean;
}

export interface SessionCreateResponse {
  id: string;
  status: SessionStatus;
  createdAt: string;
}

export interface SessionStatusResponse {
  id: string;
  status: SessionStatus;
  createdAt: string;
  uptime: number;
  sandboxId: string;
  sseConnectionCount: number;
}

export interface SSEEvent {
  event: "stdout" | "stderr" | "status" | "exit";
  data: Record<string, unknown>;
}

export interface ErrorResponse {
  error: string;
}

export interface HealthResponse {
  ok: boolean;
  sessions: number;
  uptime: number;
}
