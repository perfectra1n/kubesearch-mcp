import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // node20 is the minimum supported runtime (see package.json engines);
  // CI and the Docker image run the version pinned in .nvmrc.
  target: "node20",
  outDir: "dist",
  clean: true,
  // The bundle ships in the image and the npm tarball; maps would roughly
  // double dist/ for stack traces into a single pinned bundle.
  sourcemap: false,
  // better-sqlite3 is a native module — keep it external so its prebuilt
  // binary is resolved from node_modules at runtime instead of being bundled.
  external: ["better-sqlite3"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
