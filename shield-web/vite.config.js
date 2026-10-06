import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 8043,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.SHIELD_PROXY || "http://127.0.0.1:3043",
        ws: true,
      },
      "/ingest/shield": {
        target: process.env.SHIELD_PROXY || "http://127.0.0.1:3043",
      },
    },
  },
});
