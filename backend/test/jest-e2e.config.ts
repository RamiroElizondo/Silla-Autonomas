import type { Config } from 'jest';

// Tests "e2e" en el sentido de este proyecto: levantan un modulo real de
// Nest (TestingModule + supertest) pero SIN base de datos: PrismaService
// se mockea en cada test. Viven en test/, con extension .e2e-spec.ts.
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: {
    // Ver el comentario en jest.config.ts sobre isolatedModules.
    '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
};

export default config;
