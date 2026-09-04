import { build } from "esbuild";

await build({
  entryPoints: ["internal/bridge/assets-src/discord_bridge.js"],
  outfile: "internal/bridge/assets/discord_bridge.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  legalComments: "none",
  charset: "utf8",
  minify: false,
  treeShaking: true,
  sourcemap: false,
  write: true,
});
