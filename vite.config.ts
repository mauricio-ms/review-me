import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

/**
 * The version this build reports (`scripts/version.sh`). The Docker build has no
 * `.git`, so packaging/build-ubuntu.sh works it out beforehand and passes it in.
 */
function buildVersion(): string {
  if (process.env.REVIEW_ME_VERSION) return process.env.REVIEW_ME_VERSION;
  try {
    return execFileSync("./scripts/version.sh", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react()],
  // Read through src/lib/version.ts.
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion()),
    __APP_BUILT__: JSON.stringify(Math.floor(Date.now() / 1000)),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
