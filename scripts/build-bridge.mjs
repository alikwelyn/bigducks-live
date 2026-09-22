import { readFileSync } from "node:fs";
import { build } from "esbuild";

const mediaPageSource = readFileSync("internal/bridge/assets-src/media_bridge_page.js", "utf8");

await build({
  entryPoints: ["internal/bridge/assets-src/discord_bridge.js"],
  outfile: process.env.BIG_DUCKS_BRIDGE_OUTPUT || "internal/bridge/assets/discord_bridge.js",
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
  define: {
    __BIG_DUCKS_RELEASE__: JSON.stringify(process.env.BIG_DUCKS_VERSION || "0.1.7"),
    __BIG_DUCKS_MEDIA_PAGE__: JSON.stringify(mediaPageSource),
  },
  write: true,
});
