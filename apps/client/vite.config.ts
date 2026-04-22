/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Bind the workspace dep to its built dist so vite/rollup don't depend on
      // the (sometimes Cygwin-style) symlink target inside node_modules/@chvor.
      "@chvor/shared": path.resolve(__dirname, "../../packages/shared/dist/index.js"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:9147",
      "/audio": "http://localhost:9147",
      "/ws": {
        target: "ws://localhost:9147",
        ws: true,
      },
    },
  },
});
