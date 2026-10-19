/*
 * The installer and the remote deploy script are shell, so they are tested by
 * running them: a fake target directory stands in for a machine, and the
 * interesting failures (a foreign service in the way, no network) are exercised
 * without a network or a second host.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repo = join(import.meta.dirname, "..", "..");
const installer = join(repo, "install.sh");

function run(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("sh", [installer, ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, out: (failed.stdout ?? "") + (failed.stderr ?? "") };
  }
}

test("the installer refuses an unreachable host and says what to do", () => {
  const root = mkdtempSync(join(tmpdir(), "hw-install-"));
  const result = run(
    ["--url", "https://nothing.invalid/release", "--root", root, "--no-service"],
    { HERDR_WEB_INSTALL_TRIES: "1" },
  );
  assert.notEqual(result.code, 0, "an unreachable release must fail");
  // The offline story is the point: name the --from path and a mirror.
  assert.match(result.out, /cannot reach that host/);
  assert.match(result.out, /--from/);
  assert.match(result.out, /--url/);
  assert.equal(existsSync(join(root, "herdr-web")), false, "nothing half-installed");
});

test("the installer copies a binary and skips the service on request", () => {
  const root = mkdtempSync(join(tmpdir(), "hw-install-"));
  const fake = join(root, "source-binary");
  writeFileSync(fake, "#!/bin/sh\necho fake\n");
  chmodSync(fake, 0o755);
  const result = run(["--from", fake, "--root", join(root, "app"), "--no-service"]);
  assert.equal(result.code, 0, result.out);
  const installed = join(root, "app", "herdr-web");
  assert.equal(existsSync(installed), true);
  assert.equal(readFileSync(installed, "utf8"), "#!/bin/sh\necho fake\n");
  assert.match(result.out, /skipped the service/);
});

test("the installer refuses to replace a service it did not create", () => {
  const root = mkdtempSync(join(tmpdir(), "hw-install-"));
  const home = mkdtempSync(join(tmpdir(), "hw-home-"));
  // A launchd unit pointing at a source checkout, as this repo's own machine has.
  const agents = join(home, "Library", "LaunchAgents");
  execFileSync("mkdir", ["-p", agents]);
  writeFileSync(
    join(agents, "dev.herdr-web.plist"),
    '<?xml version="1.0"?><plist><array><string>/somewhere/else/herdr-web</string></array></plist>\n',
  );
  const fake = join(root, "source-binary");
  writeFileSync(fake, "#!/bin/sh\n");
  chmodSync(fake, 0o755);
  const result = run(["--from", fake, "--root", join(root, "app")], { HOME: home });
  assert.notEqual(result.code, 0, "it must not silently replace that service");
  assert.match(result.out, /already exists and points elsewhere/);
  // And it must not have installed anything on the way to refusing.
  assert.equal(existsSync(join(root, "app", "herdr-web")), false);
});
