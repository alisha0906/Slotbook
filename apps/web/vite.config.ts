import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev, proxy API calls to the Fastify server so the app works the same
    // as in production (single-origin) without CORS juggling.
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
  build: {
    outDir: "dist",
  },
});
