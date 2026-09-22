import { defineConfig } from 'vitest/config';

// Minimo a proposito: solo testea logica pura (ej. resolverIpCliente).
// No hay setup de DOM/React acá porque estos tests no rendericzan componentes.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
