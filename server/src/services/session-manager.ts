/**
 * Session lifecycle manager.
 *
 * Tracks all active sessions, enforces concurrency limits and TTL,
 * and handles graceful shutdown.
 */

import { nanoid } from "nanoid";
import { createSandbox, type SandboxInstance, type SandboxProcess } from "./sandbox";
import { config } from "../config";
import type { Session, SessionStatus, SSEConnection, SSEEvent } from "../types";

const MAX_OUTPUT_BUFFER = 5000; // lines retained for reconnecting clients

class SessionManager {
  private sessions = new Map<string, Session>();
  private shuttingDown = false;

  constructor() {
    this.setupGracefulShutdown();
  }

  // ── Queries ──────────────────────────────────────────────────

  get activeCount(): number {
    return this.sessions.size;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Array<{ id: string; status: SessionStatus; createdAt: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      status: s.status,
      createdAt: s.createdAt,
    }));
  }

  // ── Create ───────────────────────────────────────────────────

  async create(): Promise<Session> {
    if (this.shuttingDown) {
      throw new SessionError("Server is shutting down", 503);
    }

    if (this.sessions.size >= config.MAX_CONCURRENT_SESSIONS) {
      throw new SessionError(
        `Capacity full: ${config.MAX_CONCURRENT_SESSIONS} concurrent sessions maximum`,
        429
      );
    }

    const id = nanoid(12);
    const createdAt = new Date().toISOString();

    // Register the session immediately (with "creating" status) so
    // concurrent requests see it toward the concurrency limit.
    const session: Session = {
      id,
      sandboxId: "",
      sandbox: null,
      process: null,
      sseConnections: new Set(),
      createdAt,
      status: "creating",
      ttlTimer: null,
      outputBuffer: [],
    };
    this.sessions.set(id, session);

    try {
      console.log(`[session] Creating session ${id}`);

      // 1. Spin up sandbox
      const sandbox = await createSandbox();
      session.sandboxId = sandbox.id;
      session.sandbox = sandbox;

      // 2. Spawn NullClaw interactive process
      const proc = await sandbox.spawnNullClaw();
      session.process = proc;
      session.status = "running";

      // 3. Wire up output streams → SSE broadcast + buffer
      proc.onStdout((text) => {
        this.bufferOutput(session, text);
        this.broadcast(session, { event: "stdout", data: { text } });
      });

      proc.onStderr((text) => {
        this.bufferOutput(session, text);
        this.broadcast(session, { event: "stderr", data: { text } });
      });

      proc.onExit((code) => {
        console.log(`[session] Process exited in session ${id} with code ${code}`);
        this.broadcast(session, { event: "exit", data: { code } });
        session.status = "stopped";
        // Auto-clean after process exits (give clients a moment to read the exit event)
        setTimeout(() => this.cleanup(id), 5_000);
      });

      // 4. Start TTL watchdog
      this.startTTL(session);

      console.log(
        `[session] Session ${id} running (sandbox: ${sandbox.id})`
      );

      return session;
    } catch (err) {
      // Roll back on failure
      session.status = "error";
      this.sessions.delete(id);
      console.error(`[session] Failed to create session ${id}:`, err);
      throw new SessionError("Failed to create sandbox session", 500);
    }
  }

  // ── Input ────────────────────────────────────────────────────

  async sendInput(id: string, data: string): Promise<void> {
    const session = this.requireSession(id);

    if (session.status !== "running") {
      throw new SessionError(`Session ${id} is not running (status: ${session.status})`, 400);
    }

    const proc = session.process as SandboxProcess;
    await proc.writeStdin(data);
  }

  // ── SSE ──────────────────────────────────────────────────────

  addSSEConnection(id: string, conn: SSEConnection): void {
    const session = this.requireSession(id);
    session.sseConnections.add(conn);
  }

  removeSSEConnection(id: string, conn: SSEConnection): void {
    const session = this.sessions.get(id);
    if (session) {
      conn.active = false;
      session.sseConnections.delete(conn);
    }
  }

  /**
   * Get buffered output for replaying to late-joining SSE clients.
   */
  getOutputBuffer(id: string): string[] {
    const session = this.requireSession(id);
    return session.outputBuffer;
  }

  // ── Destroy ──────────────────────────────────────────────────

  async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new SessionError(`Session ${id} not found`, 404);
    }

    console.log(`[session] Destroying session ${id}`);
    session.status = "stopping";

    // Notify all SSE clients
    this.broadcast(session, { event: "exit", data: { code: -1 } });

    await this.cleanup(id);
  }

  // ── Internals ────────────────────────────────────────────────

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new SessionError(`Session ${id} not found`, 404);
    }
    return session;
  }

  private broadcast(session: Session, event: SSEEvent): void {
    const payload = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    const encoded = new TextEncoder().encode(payload);

    for (const conn of session.sseConnections) {
      if (!conn.active) {
        session.sseConnections.delete(conn);
        continue;
      }
      try {
        conn.controller.enqueue(encoded);
      } catch (err) {
        console.error(`[sse] Failed to enqueue to connection ${conn.id}:`, err);
        conn.active = false;
        session.sseConnections.delete(conn);
      }
    }
  }

  private bufferOutput(session: Session, text: string): void {
    session.outputBuffer.push(text);
    // Trim buffer if it gets too large
    if (session.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      session.outputBuffer = session.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
    }
  }

  private startTTL(session: Session): void {
    const ttlMs = config.SESSION_TTL_MINUTES * 60 * 1000;
    session.ttlTimer = setTimeout(() => {
      console.log(`[session] TTL expired for session ${session.id}`);
      this.broadcast(session, {
        event: "status",
        data: { status: "ttl_expired", message: "Session timed out" },
      });
      this.cleanup(session.id);
    }, ttlMs);
  }

  private async cleanup(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    // Clear TTL timer
    if (session.ttlTimer) {
      clearTimeout(session.ttlTimer);
      session.ttlTimer = null;
    }

    // Kill the process
    if (session.process) {
      try {
        await (session.process as SandboxProcess).kill();
      } catch {
        // Already dead
      }
    }

    // Close all SSE connections
    for (const conn of session.sseConnections) {
      conn.active = false;
      try {
        conn.controller.close();
      } catch {
        // Already closed
      }
    }
    session.sseConnections.clear();

    // Destroy the sandbox
    if (session.sandbox) {
      try {
        await (session.sandbox as SandboxInstance).destroy();
      } catch (err) {
        console.error(`[session] Error destroying sandbox for ${id}:`, err);
      }
    }

    session.status = "stopped";
    this.sessions.delete(id);
    console.log(`[session] Session ${id} cleaned up`);
  }

  // ── Graceful Shutdown ────────────────────────────────────────

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;

      console.log(
        `[session] ${signal} received — shutting down ${this.sessions.size} session(s)`
      );

      const cleanupPromises: Promise<void>[] = [];
      for (const id of this.sessions.keys()) {
        cleanupPromises.push(this.cleanup(id));
      }

      await Promise.allSettled(cleanupPromises);
      console.log("[session] All sessions cleaned up, exiting");
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }
}

/**
 * Custom error class that carries an HTTP status code for the error
 * handling middleware to use.
 */
export class SessionError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = "SessionError";
  }
}

/** Singleton session manager instance. */
export const sessionManager = new SessionManager();
