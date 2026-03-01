import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useTerminal, ConnectionStatus } from "../hooks/useTerminal";
import StatusBar from "./StatusBar";

interface TerminalProps {
  sessionId: string;
  onSessionEnd: () => void;
  onEndSession: () => void;
}

function safeFit(fitAddon: FitAddon | null) {
  if (!fitAddon) return;
  try {
    fitAddon.fit();
  } catch {
    // FitAddon throws if container has zero dimensions — ignore
  }
}

export default function TerminalComponent({
  sessionId,
  onSessionEnd,
  onEndSession,
}: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [terminal, setTerminal] = useState<XTerminal | null>(null);

  // Initialize xterm.js once
  useEffect(() => {
    const container = termRef.current;
    if (!container) return;

    const term = new XTerminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 14,
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: "#0a0a0a",
        foreground: "#e0e0e0",
        cursor: "#e0e0e0",
        selectionBackground: "#3a3a5c",
        black: "#0a0a0a",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#6272a4",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#e0e0e0",
        brightBlack: "#555555",
        brightRed: "#ff6e6e",
        brightGreen: "#69ff94",
        brightYellow: "#ffffa5",
        brightBlue: "#d6acff",
        brightMagenta: "#ff92df",
        brightCyan: "#a4ffff",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(container);

    fitAddonRef.current = fitAddon;

    // Delay fit until after the browser has laid out the container.
    // requestAnimationFrame ensures the DOM dimensions are available.
    requestAnimationFrame(() => {
      safeFit(fitAddon);
      // Set terminal state after fit so useTerminal gets correct dimensions
      setTerminal(term);
      term.focus();
    });

    return () => {
      term.dispose();
      setTerminal(null);
      fitAddonRef.current = null;
    };
  }, []);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => safeFit(fitAddonRef.current);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleSessionEnd = useCallback(() => {
    onSessionEnd();
  }, [onSessionEnd]);

  const { connectionStatus, uptime } = useTerminal({
    terminal,
    sessionId,
    onSessionEnd: handleSessionEnd,
  });

  return (
    <div className="terminal-container">
      <div className="terminal-wrapper" ref={termRef} />
      <StatusBar
        sessionId={sessionId}
        uptime={uptime}
        connectionStatus={connectionStatus as ConnectionStatus}
        onEndSession={onEndSession}
      />
    </div>
  );
}
