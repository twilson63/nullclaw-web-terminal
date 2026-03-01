import { useState, useCallback } from "react";
import {
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  getSessionStatus,
} from "../lib/api";

const STORAGE_KEY = "nullclaw-session-id";

export interface SessionState {
  sessionId: string | null;
  status: "idle" | "creating" | "running" | "ended" | "error";
  error: string | null;
  isLoading: boolean;
}

export function useSession() {
  const [state, setState] = useState<SessionState>({
    sessionId: null,
    status: "idle",
    error: null,
    isLoading: false,
  });

  const createSession = useCallback(async () => {
    setState({ sessionId: null, status: "creating", error: null, isLoading: true });
    try {
      const session = await apiCreateSession();
      localStorage.setItem(STORAGE_KEY, session.id);
      setState({
        sessionId: session.id,
        status: "running",
        error: null,
        isLoading: false,
      });
      return session.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create session";
      setState({ sessionId: null, status: "error", error: message, isLoading: false });
      return null;
    }
  }, []);

  const endSession = useCallback(async () => {
    const id = state.sessionId;
    if (!id) return;
    try {
      await apiDeleteSession(id);
    } catch {
      // Session may already be gone — that's fine
    }
    localStorage.removeItem(STORAGE_KEY);
    setState({ sessionId: null, status: "ended", error: null, isLoading: false });
  }, [state.sessionId]);

  const reconnectSession = useCallback(async (id: string) => {
    setState({ sessionId: null, status: "creating", error: null, isLoading: true });
    try {
      const status = await getSessionStatus(id);
      if (status.status === "running") {
        setState({
          sessionId: id,
          status: "running",
          error: null,
          isLoading: false,
        });
        return id;
      } else {
        // Session is no longer active
        localStorage.removeItem(STORAGE_KEY);
        setState({
          sessionId: null,
          status: "idle",
          error: "Previous session has ended",
          isLoading: false,
        });
        return null;
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      setState({
        sessionId: null,
        status: "idle",
        error: "Could not reconnect to previous session",
        isLoading: false,
      });
      return null;
    }
  }, []);

  const resetToLanding = useCallback(() => {
    setState({ sessionId: null, status: "idle", error: null, isLoading: false });
  }, []);

  const getSavedSessionId = useCallback((): string | null => {
    return localStorage.getItem(STORAGE_KEY);
  }, []);

  return {
    ...state,
    createSession,
    endSession,
    reconnectSession,
    resetToLanding,
    getSavedSessionId,
  };
}
