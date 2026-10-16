import { defineConfig, mergeConfig } from "vite";
import { realpathSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import base from "./vite.config";
export default mergeConfig(base, defineConfig({ server: { host: "127.0.0.1", port: Number(process.env.VISCERA_QA_PORT ?? 5189), strictPort: true,
  fs: { allow: [fileURLToPath(new URL("../..", import.meta.url)), realpathSync(fileURLToPath(new URL("../../node_modules", import.meta.url)))] },
  proxy: { "/api": { target: process.env.VISCERA_QA_API_URL ?? "http://127.0.0.1:8004", changeOrigin: true } } } }));
