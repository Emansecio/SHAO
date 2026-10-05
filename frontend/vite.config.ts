import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Em produção o backend serve o dist same-origin (base relativo).
// Em dev, /api vai para o backend local: SHAO_API_URL ou 127.0.0.1:SHAO_PORT (padrão do contrato: 4317).
const apiTarget = process.env.SHAO_API_URL ?? `http://127.0.0.1:${process.env.SHAO_PORT ?? "4317"}`;

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    proxy: { "/api": { target: apiTarget, changeOrigin: false } },
  },
  build: { chunkSizeWarningLimit: 1200 },
});
