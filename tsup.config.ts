import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  // Named entries, so `ui/embed.tsx` lands next to the others as `dist/embed.js`, with its styles in `dist/embed.css`.
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
    worker: "src/worker.ts",
    embed: "ui/embed.tsx",
  },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  format: ["esm"],
  dts: true,
  clean: true,
  define: {
    __PACK_VERSION__: JSON.stringify(pkg.version),
  },
});
