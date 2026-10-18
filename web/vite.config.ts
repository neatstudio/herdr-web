import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backend =
    process.env.VITE_BACKEND_URL || env.VITE_BACKEND_URL || "http://127.0.0.1:18080";
  return {
    // Relative base: the bundle is embedded into the Go binary and can be
    // served from any mount point (default "/").
    base: "./",
    plugins: [react()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5175,
      proxy: {
        "/api": { target: backend, changeOrigin: true },
      },
    },
    build: {
      target: "es2022",
      sourcemap: true,
    },
  };
});
