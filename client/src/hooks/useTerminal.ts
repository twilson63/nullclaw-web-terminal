import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { sendInput, getStreamUrl } from "../lib/api";

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

interface UseTerminalOptions {
  terminal: Terminal | null;
  sessionId: string | null;
  onSessionEnd?: () => void;
}

const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

export function useTerminal({ terminal, sessionId, onSessionEnd }: UseTerminalOptions) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [uptime, setUptime] = useState<number>(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const sessionEndedRef = useRef(false);
  const waitingRef = useRef(false);
  const spinnerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const spinnerFrameRef = useRef(0);

  const stopSpinner = useCallback(() => {
    if (spinnerIntervalRef.current) {
      clearInterval(spinnerIntervalRef.current);
      spinnerIntervalRef.current = null;
    }
    if (waitingRef.current && terminal) {
      // Erase the spinner: \r moves to start of line, \x1b[2K clears the line
      terminal.write("\r\x1b[2K");
      waitingRef.current = false;
    }
  }, [terminal]);

  const startSpinner = useCallback(() => {
    if (!terminal || waitingRef.current) return;
    waitingRef.current = true;
    spinnerFrameRef.current = 0;

    // Write initial spinner
    terminal.write(`\x1b[90m${SPINNER_FRAMES[0]} thinking...\x1b[0m`);

    spinnerIntervalRef.current = setInterval(() => {
      spinnerFrameRef.current = (spinnerFrameRef.current + 1) % SPINNER_FRAMES.length;
      const frame = SPINNER_FRAMES[spinnerFrameRef.current];
      // Move to start of line, clear it, write new frame
      terminal.write(`\r\x1b[2K\x1b[90m${frame} thinking...\x1b[0m`);
    }, 80);
  }, [terminal]);

  const cleanup = useCallback(() => {
    stopSpinner();
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, [stopSpinner]);

  useEffect(() => {
    if (!terminal || !sessionId) {
      cleanup();
      setConnectionStatus("disconnected");
      return;
    }

    sessionEndedRef.current = false;

    const connect = () => {
      cleanup();

      const url = getStreamUrl(sessionId);
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.addEventListener("stdout", (e: MessageEvent) => {
        try {
          const { text } = JSON.parse(e.data);
          // Stop spinner as soon as output arrives
          stopSpinner();
          terminal.write(text);
        } catch {
          // Malformed data — skip
        }
      });

      es.addEventListener("stderr", (e: MessageEvent) => {
        try {
          const { text } = JSON.parse(e.data);
          stopSpinner();
          terminal.write(`\x1b[33m${text}\x1b[0m`);
        } catch {
          // Malformed data — skip
        }
      });

      es.addEventListener("status", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.uptime !== undefined) {
            setUptime(data.uptime);
          }
        } catch {
          // Malformed data — skip
        }
      });

      es.addEventListener("exit", (e: MessageEvent) => {
        sessionEndedRef.current = true;
        stopSpinner();
        try {
          const { code } = JSON.parse(e.data);
          terminal.write(`\r\n\x1b[90m--- Session ended (exit code: ${code}) ---\x1b[0m\r\n`);
        } catch {
          terminal.write(`\r\n\x1b[90m--- Session ended ---\x1b[0m\r\n`);
        }
        setConnectionStatus("disconnected");
        cleanup();
        onSessionEnd?.();
      });

      es.onopen = () => {
        setConnectionStatus("connected");
        retryCountRef.current = 0;
      };

      es.onerror = () => {
        if (sessionEndedRef.current) return;

        es.close();
        eventSourceRef.current = null;
        setConnectionStatus("reconnecting");

        const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 10000);
        retryCountRef.current++;

        retryTimeoutRef.current = setTimeout(() => {
          if (!sessionEndedRef.current) {
            connect();
          }
        }, delay);
      };
    };

    connect();

    // Wire up terminal input → POST /api/sessions/:id/input
    // Since there's no PTY, we need to handle local echo ourselves.
    const inputDisposable = terminal.onData((data: string) => {
      if (sessionEndedRef.current) return;

      // Local echo: display typed characters in the terminal
      for (const ch of data) {
        if (ch === "\r") {
          // Enter key: show newline locally, start thinking spinner
          terminal.write("\r\n");
          startSpinner();
        } else if (ch === "\x7f") {
          // Backspace: move cursor back, overwrite with space, move back
          terminal.write("\b \b");
        } else if (ch >= " ") {
          // Printable character: echo it
          terminal.write(ch);
        }
      }

      // Convert \r (Enter key) to \n for NullClaw's stdin (no PTY)
      const converted = data.replace(/\r/g, "\n");
      sendInput(sessionId, converted);
    });

    return () => {
      cleanup();
      inputDisposable.dispose();
    };
  }, [terminal, sessionId, cleanup, onSessionEnd, startSpinner, stopSpinner]);

  return { connectionStatus, uptime };
}
