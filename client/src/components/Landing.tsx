interface LandingProps {
  onStart: () => void;
  onReconnect: (id: string) => void;
  savedSessionId: string | null;
  isLoading: boolean;
  error: string | null;
}

export default function Landing({
  onStart,
  onReconnect,
  savedSessionId,
  isLoading,
  error,
}: LandingProps) {
  return (
    <div className="landing">
      <div className="landing-content">
        <h1 className="landing-title">
          <span className="landing-title-null">Null</span>
          <span className="landing-title-claw">Claw</span>
          <span className="landing-title-suffix"> Web Terminal</span>
        </h1>

        <p className="landing-tagline">
          An AI agent in your browser. Zero setup.
        </p>

        <div className="landing-actions">
          <button
            className="btn-primary"
            onClick={onStart}
            disabled={isLoading}
          >
            {isLoading ? "Starting..." : "Start Session"}
          </button>

          {savedSessionId && !isLoading && (
            <button
              className="btn-secondary"
              onClick={() => onReconnect(savedSessionId)}
            >
              Reconnect to existing session
            </button>
          )}
        </div>

        {error && <p className="landing-error">{error}</p>}

        <div className="landing-stats">
          <span className="stat">678 KB binary</span>
          <span className="stat-separator">&middot;</span>
          <span className="stat">&lt;2s boot</span>
          <span className="stat-separator">&middot;</span>
          <span className="stat">30 min sessions</span>
        </div>
      </div>
    </div>
  );
}
