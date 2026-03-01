/**
 * NullClaw Snapshot Provisioning Script
 *
 * Creates a reusable Deno Sandbox snapshot with NullClaw pre-installed.
 * Sessions booted from this snapshot start in <1 second.
 *
 * Uses the @deno/sandbox SDK v0.12.0+ which has Client, Volume, and
 * Snapshot APIs for managing volumes and snapshots programmatically.
 *
 * Usage:
 *   npx tsx scripts/create-snapshot.ts [--force]
 *
 * Environment variables:
 *   DENO_DEPLOY_TOKEN  - Required. Auth token from console.deno.com.
 *   NULLCLAW_SNAPSHOT  - Snapshot slug (default: "nullclaw-snapshot")
 *   DENO_REGION        - Region for volumes/sandboxes (default: "ord")
 *   NULLCLAW_URL       - URL to the NullClaw binary (has default placeholder)
 */

import { Client, Sandbox } from "@deno/sandbox";
import type { Region } from "@deno/sandbox";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SNAPSHOT_SLUG =
  process.env.NULLCLAW_SNAPSHOT ?? "nullclaw-snapshot";
const BUILD_VOLUME_SLUG = `${SNAPSHOT_SLUG}-build`;
const REGION = (process.env.DENO_REGION ?? "ord") as Region;
const NULLCLAW_URL =
  process.env.NULLCLAW_URL ??
  "https://github.com/nullclaw/nullclaw/releases/download/v2026.2.26/nullclaw-linux-x86_64.bin";
const FORCE = process.argv.includes("--force");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function fatal(msg: string, err?: unknown): never {
  const ts = new Date().toISOString();
  console.error(`[${ts}] FATAL: ${msg}`);
  if (err) console.error(err);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.DENO_DEPLOY_TOKEN) {
    fatal("DENO_DEPLOY_TOKEN is required. Set it in your environment.");
  }

  log("NullClaw snapshot provisioning starting");
  log(`  Snapshot slug : ${SNAPSHOT_SLUG}`);
  log(`  Build volume  : ${BUILD_VOLUME_SLUG}`);
  log(`  Region        : ${REGION}`);
  log(`  Binary URL    : ${NULLCLAW_URL}`);
  log(`  Force rebuild : ${FORCE}`);

  const client = new Client();

  // -----------------------------------------------------------------------
  // Step 0: Check if snapshot already exists
  // -----------------------------------------------------------------------
  log("Checking if snapshot already exists...");
  const existingSnapshot = await client.snapshots.get(SNAPSHOT_SLUG);

  if (existingSnapshot && !FORCE) {
    log(`Snapshot "${SNAPSHOT_SLUG}" already exists (id: ${existingSnapshot.id}). Use --force to rebuild.`);
    log("Done (no-op).");
    return;
  }

  if (existingSnapshot && FORCE) {
    log(`Snapshot "${SNAPSHOT_SLUG}" exists but --force specified. Deleting...`);
    await client.snapshots.delete(SNAPSHOT_SLUG);
    log("Existing snapshot deleted.");
  }

  // -----------------------------------------------------------------------
  // Step 1: Clean up leftover resources from previous failed runs
  // -----------------------------------------------------------------------
  log("Cleaning up any leftover resources...");

  // Kill any running sandboxes that might be holding volumes
  try {
    const sandboxes = await client.sandboxes.list();
    for (const sbx of sandboxes) {
      if (sbx.status === "running") {
        log(`  Killing orphaned sandbox ${sbx.id}...`);
        try {
          const s = await Sandbox.connect(sbx.id);
          await s.kill();
        } catch {
          // best effort
        }
      }
    }
  } catch {
    // listing might fail — fine
  }

  // Delete leftover build volume
  try {
    await client.volumes.delete(BUILD_VOLUME_SLUG);
    log(`  Cleaned up leftover build volume "${BUILD_VOLUME_SLUG}".`);
  } catch {
    // No leftover — that's fine
  }

  // Short pause to let Deno's backend settle after deletions
  log("Waiting a few seconds for cleanup to propagate...");
  await new Promise((r) => setTimeout(r, 5000));

  // -----------------------------------------------------------------------
  // Step 2: Create bootable volume from debian-13
  // -----------------------------------------------------------------------
  log("Creating bootable volume from builtin:debian-13...");
  let volume;
  try {
    volume = await client.volumes.create({
      slug: BUILD_VOLUME_SLUG,
      region: REGION,
      capacity: "2GB",
      from: "builtin:debian-13",
    });
    log(`Volume created: id=${volume.id}, slug=${volume.slug}`);
  } catch (err) {
    fatal(
      "Failed to create build volume. This may be a transient Deno API error — wait a minute and try again.",
      err,
    );
  }

  // -----------------------------------------------------------------------
  // Step 3: Boot sandbox with volume as writable root
  // -----------------------------------------------------------------------
  log("Booting sandbox from build volume...");
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create({
      region: REGION,
      root: BUILD_VOLUME_SLUG,
      timeout: "10m",
    });
    log(`Sandbox booted: ${sandbox.id}`);
  } catch (err) {
    log("Sandbox boot failed. Cleaning up build volume...");
    try { await client.volumes.delete(BUILD_VOLUME_SLUG); } catch { /* best effort */ }
    fatal("Failed to boot sandbox from build volume.", err);
  }

  try {
    // -------------------------------------------------------------------
    // Step 4: Download NullClaw binary via curl inside the sandbox
    // -------------------------------------------------------------------
    log(`Downloading NullClaw binary inside sandbox from ${NULLCLAW_URL}...`);
    const installResult = await sandbox.sh`curl -L ${NULLCLAW_URL} -o /usr/local/bin/nullclaw && chmod +x /usr/local/bin/nullclaw && ls -lh /usr/local/bin/nullclaw`.sudo();
    log(`Install output: ${installResult.stdout}`);

    // -------------------------------------------------------------------
    // Step 5: Install Mozilla CA certificates for TLS
    // -------------------------------------------------------------------
    // NullClaw (static Zig binary) uses Zig's built-in TLS which hardcodes
    // Linux cert paths. Without these certs, all HTTPS requests fail with
    // TlsInitializationFailed. We bake them into the snapshot so every
    // session gets them instantly without downloading at boot time.
    log("Installing CA certificates...");
    const certScript = [
      'const resp = await fetch("https://curl.se/ca/cacert.pem");',
      'if (!resp.ok) { console.error("fetch failed: " + resp.status); Deno.exit(1); }',
      'const pem = await resp.text();',
      'await Deno.writeTextFile("/tmp/ca-certificates.crt", pem);',
      'const count = pem.split("-----BEGIN CERTIFICATE-----").length - 1;',
      'console.log("Downloaded " + count + " CA certs");',
    ].join("\n");
    await sandbox.fs.writeTextFile("/tmp/install-certs.ts", certScript);
    const certDownload = await sandbox.sh`deno run --allow-net --allow-read --allow-write /tmp/install-certs.ts`;
    log(`CA cert download: ${certDownload.stdout}`);
    await sandbox.sh`sudo mkdir -p /etc/ssl/certs /etc/pki/tls/certs && sudo cp /tmp/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt && sudo cp /tmp/ca-certificates.crt /etc/ssl/cert.pem && sudo cp /tmp/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt`;
    log("CA certs installed to /etc/ssl/");

    // -------------------------------------------------------------------
    // Step 6: Verify binary works
    // -------------------------------------------------------------------
    log("Verifying NullClaw binary...");
    const versionResult = await sandbox.sh`/usr/local/bin/nullclaw --version`;
    const versionText = versionResult.stdout?.trim() ?? "";
    log(`NullClaw version: ${versionText}`);

    if (!versionText) {
      throw new Error("nullclaw --version returned empty output");
    }

    // -------------------------------------------------------------------
    // Step 7: Shutdown sandbox before snapshotting
    // -------------------------------------------------------------------
    log("Shutting down sandbox before snapshot...");
    await sandbox.kill();
    log("Sandbox killed.");

    // -------------------------------------------------------------------
    // Step 8: Create snapshot from the build volume
    // -------------------------------------------------------------------
    log(`Creating snapshot "${SNAPSHOT_SLUG}" from build volume...`);
    const snapshot = await client.volumes.snapshot(volume.id, {
      slug: SNAPSHOT_SLUG,
    });
    log(`Snapshot created: id=${snapshot.id}, slug=${snapshot.slug}, bootable=${snapshot.isBootable}`);

    // -------------------------------------------------------------------
    // Step 9: Verify snapshot boots correctly
    // -------------------------------------------------------------------
    log("Verifying snapshot by booting a test sandbox...");
    try {
      const testSandbox = await Sandbox.create({
        region: REGION,
        root: SNAPSHOT_SLUG,
        timeout: "2m",
      });
      const testVersion = await testSandbox.sh`/usr/local/bin/nullclaw --version`;
      log(`Snapshot verification: nullclaw --version => ${testVersion.stdout?.trim()}`);
      await testSandbox.kill();
      log("Snapshot verification passed.");
    } catch (err) {
      log(`Warning: snapshot verification failed: ${err}`);
      log("The snapshot was created but may not boot correctly. Investigate manually.");
    }
  } catch (err) {
    // Attempt to kill sandbox on failure
    try { await sandbox.kill(); } catch { /* best effort */ }
    // Attempt to clean up the build volume
    try { await client.volumes.delete(BUILD_VOLUME_SLUG); } catch { /* best effort */ }
    fatal("Snapshot provisioning failed.", err);
  }

  // -----------------------------------------------------------------------
  // Step 10: Clean up build volume
  // -----------------------------------------------------------------------
  log(`Cleaning up build volume "${BUILD_VOLUME_SLUG}"...`);
  try {
    await client.volumes.delete(BUILD_VOLUME_SLUG);
    log("Build volume deleted.");
  } catch (err) {
    log(`Warning: failed to delete build volume: ${err}`);
    log("You may need to delete it manually via the Deno dashboard.");
  }

  // -----------------------------------------------------------------------
  // Done
  // -----------------------------------------------------------------------
  log("========================================");
  log("Snapshot provisioning complete!");
  log(`  Snapshot slug: ${SNAPSHOT_SLUG}`);
  log(`  Region:        ${REGION}`);
  log("");
  log("Use this snapshot slug in your server config:");
  log(`  NULLCLAW_SNAPSHOT=${SNAPSHOT_SLUG}`);
  log("========================================");
}

main().catch((err) => fatal("Unhandled error in main.", err));
