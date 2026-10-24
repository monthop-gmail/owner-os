import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Local Worker started with `wrangler dev --local` (default port 8787).
const WORKER_URL = "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": WORKER_URL,
      "/test-camera": WORKER_URL,
    },
  },
  test: {
    environment: "jsdom",
  },
});
