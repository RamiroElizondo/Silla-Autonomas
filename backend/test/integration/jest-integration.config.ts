import type { Config } from 'jest';

// Tests de integración: usan un Postgres REAL (no se mockea Prisma) para
// probar condiciones de carrera y constraints de la base de datos que un
// mock en memoria no puede reproducir de verdad (ver el comentario al tope
// de test/integration/pagos-race.int-spec.ts). Viven en test/integration/,
// con extension .int-spec.ts, y requieren TEST_DATABASE_URL — no corren
// como parte de `npm test` ni de `npm run test:e2e`.
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '../..',
  roots: ['<rootDir>/test/integration'],
  testRegex: '.*\\.int-spec\\.ts$',
  transform: {
    // Ver el comentario en jest.config.ts sobre isolatedModules.
    '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }],
  },
  // Serial: todos los archivos comparten la MISMA base y ColaService asigna
  // cualquier silla LIBRE de la base, así que en paralelo se pisarían.
  maxWorkers: 1,
  moduleFileExtensions: ['js', 'json', 'ts'],
};

export default config;
