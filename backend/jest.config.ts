import type { Config } from 'jest';

// Tests unitarios: todo lo que vive junto al código en src, con extension
// .spec.ts. No levanta ningun modulo de Nest ni toca la base de datos.
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // isolatedModules: los tests no dependen de un chequeo de tipos de
    // proyecto completo (eso ya lo hace `npx tsc --noEmit` aparte). Evita
    // que un archivo con tipos desactualizados en otro lado (ej. el
    // cliente de Prisma antes de correr `prisma generate`) tire abajo
    // tests que ni lo tocan.
    '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }],
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  moduleFileExtensions: ['js', 'json', 'ts'],
};

export default config;
