import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedPath = join(root, "internal", "bridge", "assets", "discord_bridge.js");
const sourcePath = join(root, "internal", "bridge", "assets-src", "discord_bridge.js");
const temporaryPath = join(tmpdir(), `bigducks-bridge-check-${process.pid}.js`);
try {
  const result = spawnSync(process.execPath, [join(root, "scripts", "build-bridge.mjs")], {
    cwd: root,
    env: { ...process.env, BIG_DUCKS_BRIDGE_OUTPUT: temporaryPath },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);

  const expected = readFileSync(expectedPath);
  const generated = readFileSync(temporaryPath);
  if (!expected.equals(generated)) {
    console.error(`Bridge bundle differs from the reproducible output: ${expectedPath}`);
    process.exitCode = 1;
  }

  const source = readFileSync(sourcePath, "utf8");
  for (const fragment of [
    "@sentry/electron/renderer",
    "captureException(",
    "setUser(",
    "window.Sentry",
    "globalThis.Sentry",
    "Authorization",
    "token=",
  ]) {
    if (source.includes(fragment)) {
      console.error(`Bridge source contains a forbidden telemetry fragment: ${fragment}`);
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(temporaryPath, { force: true });
}
