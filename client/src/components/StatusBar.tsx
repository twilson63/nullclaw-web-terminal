import { useState } from "react";
import type { ConnectionStatus } from "../hooks/useTerminal";

interface StatusBarProps {
  sessionId: string;
  uptime: number;
  connectionStatus: ConnectionStatus;
  onEndSession: () => void;
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function statusIndicator(status: ConnectionStatus) {
  const colors: Record<ConnectionStatus, string> = {
    connected: "#50fa7b",
    reconnecting: "#f1fa8c",
    disconnected: "#ff5555",
  };
  const labels: Record<ConnectionStatus, string> = {
    connected: "Connected",
    reconnecting: "Reconnecting...",
    disconnected: "Disconnected",
  };
  return (
    <span className="status-indicator">
      <span
        className="status-dot"
        style={{ backgroundColor: colors[status] }}
      />
      <span className="status-label">{labels[status]}</span>
    </span>
  );
}

export default function StatusBar({
  sessionId,
  uptime,
  connectionStatus,
  onEndSession,
}: StatusBarProps) {
  const [confirming, setConfirming] = useState(false);

  const handleEnd = () => {
    if (confirming) {
      onEndSession();
      setConfirming(false);
    } else {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
    }
  };

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {statusIndicator(connectionStatus)}
        <span className="status-session-id">
          {sessionId.substring(0, 8)}
        </span>
        <span className="status-uptime">{formatUptime(uptime)}</span>
      </div>
      <div className="status-bar-right">
        <button
          className={`btn-end-session ${confirming ? "btn-confirm" : ""}`}
          onClick={handleEnd}
        >
          {confirming ? "Confirm End?" : "End Session"}
        </button>
      </div>
    </div>
  );
}
