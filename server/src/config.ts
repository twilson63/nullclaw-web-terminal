/**
 * Environment configuration parsing and validation.
 *
 * All required env vars are validated at startup. Missing required
 * vars cause the server to exit immediately with a clear message.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env file manually (Node doesn't auto-load like Bun)
try {
  const envPath = resolve(import.meta.dirname ?? ".", "..", ".env");
  const envFile = readFileSync(envPath, "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // No .env file — rely on environment variables
}

export interface Config {
  DENO_DEPLOY_TOKEN: string;
  NULLCLAW_SNAPSHOT: string;
  DENO_REGION: string;
  LLM_API_KEY: string;
  LLM_API_HOST: string;
  LLM_PROVIDER: string;
  LLM_MODEL: string;
  PORT: number;
  MAX_CONCURRENT_SESSIONS: number;
  SESSION_TTL_MINUTES: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function optionalIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    console.error(`[config] Invalid integer for ${name}: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

export function loadConfig(): Config {
  return {
    DENO_DEPLOY_TOKEN: requireEnv("DENO_DEPLOY_TOKEN"),
    LLM_API_KEY: requireEnv("LLM_API_KEY"),
    NULLCLAW_SNAPSHOT: optionalEnv("NULLCLAW_SNAPSHOT", "nullclaw-snapshot"),
    DENO_REGION: optionalEnv("DENO_REGION", "ord"),
    LLM_API_HOST: optionalEnv("LLM_API_HOST", "openrouter.ai"),
    LLM_PROVIDER: optionalEnv("LLM_PROVIDER", "openrouter"),
    LLM_MODEL: optionalEnv("LLM_MODEL", "anthropic/claude-sonnet-4"),
    PORT: optionalIntEnv("PORT", 3000),
    MAX_CONCURRENT_SESSIONS: optionalIntEnv("MAX_CONCURRENT_SESSIONS", 5),
    SESSION_TTL_MINUTES: optionalIntEnv("SESSION_TTL_MINUTES", 30),
  };
}

/** Singleton config instance, initialized once at import time. */
export const config = loadConfig();
