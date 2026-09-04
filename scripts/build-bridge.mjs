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
  define: {
    __BIG_DUCKS_RELEASE__: JSON.stringify(process.env.BIG_DUCKS_VERSION || "0.1.7"),
  },
  write: true,
});
