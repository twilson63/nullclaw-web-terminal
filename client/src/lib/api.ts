const API_BASE = "";

export interface SessionResponse {
  id: string;
  status: string;
  createdAt: string;
}

export interface StatusResponse {
  id: string;
  status: string;
  uptime: number;
  createdAt: string;
}

export async function createSession(): Promise<SessionResponse> {
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error || `Failed to create session (${res.status})`);
  }
  return res.json();
}

export function sendInput(id: string, data: string): void {
  fetch(`${API_BASE}/api/sessions/${id}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
    keepalive: true,
  }).catch(() => {
    // Fire-and-forget: swallow errors for input.
    // If the session is dead, the SSE stream will notify us.
  });
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error || `Failed to delete session (${res.status})`);
  }
}

export async function getSessionStatus(id: string): Promise<StatusResponse> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}/status`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error || `Failed to get status (${res.status})`);
  }
  return res.json();
}

export function getStreamUrl(id: string): string {
  return `${API_BASE}/api/sessions/${id}/stream`;
}
