import path from "node:path";
import { defineConfig } from "vitest/config";

// Minimo a proposito: solo testea logica pura (ej. resolverIpCliente) y el
// proxy de route.ts (que a su vez es casi toda lógica pura sobre
// Request/Response estándar). No hay setup de DOM/React acá porque estos
// tests no renderizan componentes.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    // Mismo alias que tsconfig.json (paths: "@/*" -> "./src/*"), que Next
    // entiende solo, pero Vitest no resuelve sin esto.
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});
