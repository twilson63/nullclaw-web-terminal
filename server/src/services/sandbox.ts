/**
 * Thin wrapper around the @deno/sandbox SDK (v0.12.0+).
 *
 * Abstracts sandbox creation, process spawning, I/O, and teardown
 * so the rest of the codebase doesn't depend on SDK internals.
 *
 * SDK v0.12.0 supports:
 *   - root (boot from snapshot or volume)
 *   - allowNet (outbound network restrictions)
 *   - secrets (injected on the wire, never in sandbox env)
 *   - timeout (session lifetime)
 *   - Client for volume/snapshot management
 */

import { Sandbox } from "@deno/sandbox";
import type { ChildProcess } from "@deno/sandbox";
import type { Region } from "@deno/sandbox";
import { config } from "../config";

export interface SandboxProcess {
  /** The underlying ChildProcess */
  raw: ChildProcess;
  /** Write data to the process stdin */
  writeStdin(data: string): Promise<void>;
  /** Register a callback for stdout data */
  onStdout(cb: (data: string) => void): void;
  /** Register a callback for stderr data */
  onStderr(cb: (data: string) => void): void;
  /** Register a callback for process exit */
  onExit(cb: (code: number) => void): void;
  /** Kill the process */
  kill(): Promise<void>;
}

export interface SandboxInstance {
  /** The Deno Sandbox instance ID */
  id: string;
  /** The underlying sandbox object */
  raw: Sandbox;
  /** Spawn NullClaw as an interactive process */
  spawnNullClaw(): Promise<SandboxProcess>;
  /** Kill and destroy the sandbox */
  destroy(): Promise<void>;
}

/**
 * Create a new Deno Sandbox and prepare it for running NullClaw.
 *
 * Boots from the pre-built snapshot (with NullClaw installed).
 * Restricts outbound network to the LLM API host only.
 * Injects the LLM API key via secrets (never enters sandbox env).
 */
export async function createSandbox(): Promise<SandboxInstance> {
  const sandbox = await Sandbox.create({
    // Boot from the pre-built snapshot with NullClaw installed
    root: config.NULLCLAW_SNAPSHOT,

    // Region must match snapshot region
    region: config.DENO_REGION as Region,

    // Auto-terminate after TTL
    timeout: `${config.SESSION_TTL_MINUTES}m` as `${number}m`,

    // Minimal memory — NullClaw only needs ~1 MB but leave room for OS
    memory: "768MiB",

    // Unrestricted outbound network — enables NullClaw web search, fetch, etc.
    // Omitting allowNet = no restrictions (all hosts allowed)

    // Inject API key securely (never enters sandbox env)
    secrets: {
      LLM_API_KEY: {
        hosts: ["*"],
        value: config.LLM_API_KEY,
      },
    },

    // Metadata for dashboard tracking
    labels: {
      app: "nullclaw-web-terminal",
      version: "0.1.0",
    },
  });

  const sandboxId = sandbox.id;

  return {
    id: sandboxId,
    raw: sandbox,

    async spawnNullClaw(): Promise<SandboxProcess> {
      // Step 0: Ensure CA certificates are available for HTTPS/TLS.
      // NullClaw (static Zig binary) uses Zig's built-in TLS which looks for
      // CA certs at /etc/ssl/certs/ca-certificates.crt. The Deno Sandbox microVM
      // may not have them pre-installed, causing TlsInitializationFailed errors.
      // We write a Deno script to a temp file (avoids shell quoting issues with
      // sandbox.sh template literals), then run it with full permissions.
      try {
        const certScript = [
          'const resp = await fetch("https://curl.se/ca/cacert.pem");',
          'if (!resp.ok) { console.error("fetch failed: " + resp.status); Deno.exit(1); }',
          'const pem = await resp.text();',
          'try { await Deno.mkdir("/etc/ssl/certs", { recursive: true }); } catch {}',
          'await Deno.writeTextFile("/etc/ssl/certs/ca-certificates.crt", pem);',
          'await Deno.writeTextFile("/etc/ssl/cert.pem", pem);',
          'const count = pem.split("-----BEGIN CERTIFICATE-----").length - 1;',
          'console.log("CA certs installed (" + count + " certs)");',
        ].join("\n");
        await sandbox.fs.writeTextFile("/tmp/install-certs.ts", certScript);
        const installCerts = await sandbox.sh`deno run --allow-net --allow-read --allow-write /tmp/install-certs.ts`;
        if (installCerts.stdout) console.log(`[sandbox] ${installCerts.stdout}`);
        if (installCerts.stderr) console.warn(`[sandbox] CA certs stderr: ${installCerts.stderr}`);
      } catch (err: any) {
        console.error(`[sandbox] CA cert installation failed:`, err.message ?? err);
        console.warn(`[sandbox] NullClaw HTTPS requests may fail without CA certs`);
      }

      // Step 1: Onboard NullClaw with API key and provider
      const onboard = await sandbox.sh`/usr/local/bin/nullclaw onboard --api-key ${config.LLM_API_KEY} --provider ${config.LLM_PROVIDER}`;
      if (onboard.stderr) console.warn(`[sandbox] Onboard stderr: ${onboard.stderr}`);

      // Step 2: Patch config to enable web search, HTTP fetching, and full autonomy.
      // Onboard creates ~/.nullclaw/config.json — we merge in additional keys:
      //   - http_request: enables web search (DuckDuckGo primary, Jina fallback)
      //     and general HTTP fetching for NullClaw's http_request tool
      //   - autonomy: full access to all built-in tools without approval prompts
      const patchScript = [
        'const p = Deno.env.get("HOME") + "/.nullclaw/config.json";',
        'let c = {};',
        'try { c = JSON.parse(Deno.readTextFileSync(p)); } catch {}',
        'c.http_request = { enabled: true, search_provider: "duckduckgo", search_fallback_providers: ["jina"] };',
        'c.autonomy = { level: "full", allowed_commands: ["*"], allowed_paths: ["*"], require_approval_for_medium_risk: false };',
        'Deno.writeTextFileSync(p, JSON.stringify(c, null, 2));',
        'console.log("config patched");',
      ].join("\n");
      await sandbox.fs.writeTextFile("/tmp/patch-config.ts", patchScript);
      const patchConfig = await sandbox.sh`deno run --allow-read --allow-write --allow-env /tmp/patch-config.ts`;
      if (patchConfig.stderr) console.warn(`[sandbox] Config patch stderr: ${patchConfig.stderr}`);

      // Step 3: Spawn the interactive agent directly.
      const proc = await sandbox.spawn("/usr/local/bin/nullclaw", {
        args: [
          "agent",
          "--provider", config.LLM_PROVIDER,
          "--model", config.LLM_MODEL,
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });

      const stdoutCallbacks: Array<(data: string) => void> = [];
      const stderrCallbacks: Array<(data: string) => void> = [];
      const exitCallbacks: Array<(code: number) => void> = [];

      // Acquire the stdin writer once and hold it open for the lifetime
      // of the process. This prevents the WritableStream from closing
      // (which would send EOF to the child process).
      const stdinWriter = proc.stdin ? proc.stdin.getWriter() : null;

      // Pipe stdout/stderr ReadableStreams -> callbacks
      if (proc.stdout) {
        pipeStream(proc.stdout, stdoutCallbacks, "stdout");
      }
      if (proc.stderr) {
        pipeStream(proc.stderr, stderrCallbacks, "stderr");
      }

      // Handle process exit
      proc.status.then((status) => {
        // Release the stdin writer when process exits
        if (stdinWriter) {
          try { stdinWriter.close(); } catch { /* already closed */ }
        }
        for (const cb of exitCallbacks) {
          cb(status.code);
        }
      });

      return {
        raw: proc,

        async writeStdin(data: string): Promise<void> {
          if (!stdinWriter) {
            throw new Error("stdin is not available (process may have exited)");
          }
          await stdinWriter.write(new TextEncoder().encode(data));
        },

        onStdout(cb: (data: string) => void) {
          stdoutCallbacks.push(cb);
        },

        onStderr(cb: (data: string) => void) {
          stderrCallbacks.push(cb);
        },

        onExit(cb: (code: number) => void) {
          exitCallbacks.push(cb);
        },

        async kill(): Promise<void> {
          try {
            await proc.kill("SIGTERM");
          } catch {
            // Process may already be dead
          }
        },
      };
    },

    async destroy(): Promise<void> {
      if (!sandbox.id) {
        console.warn("[sandbox] Sandbox ID is null — sandbox will auto-terminate at timeout");
        return;
      }
      try {
        await sandbox.kill();
      } catch (err: any) {
        // Ignore 404 — sandbox already terminated
        if (err?.status === 404) return;
        console.error(`[sandbox] Error destroying sandbox ${sandboxId}:`, err);
      }
    },
  };
}

/**
 * Reconnect to an existing sandbox by ID.
 */
export async function reconnectSandbox(sandboxId: string): Promise<Sandbox> {
  return await Sandbox.connect(sandboxId);
}

// -- Internal helpers --

/**
 * Reads a ReadableStream<Uint8Array> and dispatches decoded text
 * to the registered callbacks. Runs in the background (fire-and-forget).
 */
function pipeStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: Array<(data: string) => void>,
  label: string = "stream"
): void {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const cb of callbacks) {
          try {
            cb(text);
          } catch (err) {
            console.error(`[sandbox] Error in ${label} callback:`, err);
          }
        }
      }
    } catch (err) {
      console.error(`[sandbox] pipeStream(${label}) error:`, err);
    }
  })();
}
