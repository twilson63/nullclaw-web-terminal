/**
 * Session CRUD and streaming routes.
 *
 * Mounted at /api/sessions in the main app.
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { sessionManager, SessionError } from "../services/session-manager";
import type { SessionCreateResponse, SessionStatusResponse, ErrorResponse } from "../types";

const sessions = new Hono();

// ── POST /api/sessions — Create a new session ─────────────────

sessions.post("/", async (c) => {
  try {
    const session = await sessionManager.create();

    const response: SessionCreateResponse = {
      id: session.id,
      status: session.status,
      createdAt: session.createdAt,
    };

    return c.json(response, 201);
  } catch (err) {
    if (err instanceof SessionError) {
      return c.json({ error: err.message } satisfies ErrorResponse, err.statusCode as any);
    }
    console.error("[routes] Unexpected error creating session:", err);
    return c.json({ error: "Internal server error" } satisfies ErrorResponse, 500);
  }
});

// ── GET /api/sessions/:id/stream — SSE stream ─────────────────

sessions.get("/:id/stream", async (c) => {
  const id = c.req.param("id");
  const session = sessionManager.get(id);

  if (!session) {
    return c.json({ error: `Session ${id} not found` } satisfies ErrorResponse, 404);
  }

  const connId = nanoid(8);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const conn = {
        id: connId,
        controller,
        active: true,
      };

      sessionManager.addSSEConnection(id, conn);

      // Replay buffered output so reconnecting clients catch up
      const buffer = sessionManager.getOutputBuffer(id);
      if (buffer.length > 0) {
        const replayText = buffer.join("");
        const replayPayload = `event: stdout\ndata: ${JSON.stringify({ text: replayText })}\n\n`;
        controller.enqueue(new TextEncoder().encode(replayPayload));
      }

      // Send current status
      const statusPayload = `event: status\ndata: ${JSON.stringify({
        status: session.status,
        uptime: Date.now() - new Date(session.createdAt).getTime(),
      })}\n\n`;
      controller.enqueue(new TextEncoder().encode(statusPayload));

      // If session is already stopped, send exit event immediately
      if (session.status === "stopped") {
        const exitPayload = `event: exit\ndata: ${JSON.stringify({ code: 0 })}\n\n`;
        controller.enqueue(new TextEncoder().encode(exitPayload));
        controller.close();
        sessionManager.removeSSEConnection(id, conn);
      }
    },
    cancel() {
      // Client disconnected — remove the connection but keep the session alive
      const session = sessionManager.get(id);
      if (session) {
        for (const conn of session.sseConnections) {
          if (conn.id === connId) {
            sessionManager.removeSSEConnection(id, conn);
            break;
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering if behind proxy
    },
  });
});

// ── POST /api/sessions/:id/input — Send keystrokes ────────────

sessions.post("/:id/input", async (c) => {
  const id = c.req.param("id");

  let body: { data?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" } satisfies ErrorResponse, 400);
  }

  if (typeof body.data !== "string") {
    return c.json(
      { error: 'Missing or invalid "data" field (expected string)' } satisfies ErrorResponse,
      400
    );
  }

  try {
    console.log(`[input] Session ${id}: ${JSON.stringify(body.data)} (status: ${sessionManager.get(id)?.status})`);
    await sessionManager.sendInput(id, body.data);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof SessionError) {
      return c.json({ error: err.message } satisfies ErrorResponse, err.statusCode as any);
    }
    console.error("[routes] Unexpected error sending input:", err);
    return c.json({ error: "Internal server error" } satisfies ErrorResponse, 500);
  }
});

// ── DELETE /api/sessions/:id — Kill session ────────────────────

sessions.delete("/:id", async (c) => {
  const id = c.req.param("id");

  try {
    await sessionManager.destroy(id);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof SessionError) {
      return c.json({ error: err.message } satisfies ErrorResponse, err.statusCode as any);
    }
    console.error("[routes] Unexpected error destroying session:", err);
    return c.json({ error: "Internal server error" } satisfies ErrorResponse, 500);
  }
});

// ── GET /api/sessions/:id/status — Session metadata ───────────

sessions.get("/:id/status", (c) => {
  const id = c.req.param("id");
  const session = sessionManager.get(id);

  if (!session) {
    return c.json({ error: `Session ${id} not found` } satisfies ErrorResponse, 404);
  }

  const response: SessionStatusResponse = {
    id: session.id,
    status: session.status,
    createdAt: session.createdAt,
    uptime: Date.now() - new Date(session.createdAt).getTime(),
    sandboxId: session.sandboxId,
    sseConnectionCount: session.sseConnections.size,
  };

  return c.json(response);
});

export { sessions };
