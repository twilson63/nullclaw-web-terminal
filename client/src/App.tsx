import { useCallback } from "react";
import { useSession } from "./hooks/useSession";
import Landing from "./components/Landing";
import TerminalComponent from "./components/Terminal";

type AppView = "landing" | "connecting" | "terminal";

function getView(status: string, sessionId: string | null): AppView {
  if (status === "creating") return "connecting";
  if (status === "running" && sessionId) return "terminal";
  return "landing";
}

export default function App() {
  const {
    sessionId,
    status,
    error,
    isLoading,
    createSession,
    endSession,
    reconnectSession,
    resetToLanding,
    getSavedSessionId,
  } = useSession();

  const view = getView(status, sessionId);

  const handleStart = useCallback(async () => {
    await createSession();
  }, [createSession]);

  const handleReconnect = useCallback(
    async (id: string) => {
      await reconnectSession(id);
    },
    [reconnectSession],
  );

  const handleSessionEnd = useCallback(() => {
    // Called when SSE reports exit — session is already dead server-side
    localStorage.removeItem("nullclaw-session-id");
    // Small delay so the user can see the exit message
    setTimeout(() => resetToLanding(), 2000);
  }, [resetToLanding]);

  const handleEndSession = useCallback(async () => {
    await endSession();
  }, [endSession]);

  if (view === "connecting") {
    return (
      <div className="connecting">
        <div className="connecting-content">
          <div className="spinner" />
          <p>Creating sandbox...</p>
        </div>
      </div>
    );
  }

  if (view === "terminal" && sessionId) {
    return (
      <TerminalComponent
        sessionId={sessionId}
        onSessionEnd={handleSessionEnd}
        onEndSession={handleEndSession}
      />
    );
  }

  return (
    <Landing
      onStart={handleStart}
      onReconnect={handleReconnect}
      savedSessionId={getSavedSessionId()}
      isLoading={isLoading}
      error={error}
    />
  );
}
