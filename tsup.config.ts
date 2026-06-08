import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // better-sqlite3 is a native module — keep it external so its prebuilt
  // binary is resolved from node_modules at runtime instead of being bundled.
  external: ["better-sqlite3"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
