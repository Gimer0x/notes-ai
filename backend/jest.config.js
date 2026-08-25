/** @type {import('jest').Config} */
const tsJest = {
  '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
};

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      transform: tsJest,
      testEnvironment: 'node',
      setupFiles: ['<rootDir>/test/setup-env.cjs'],
    },
    {
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      transform: tsJest,
      testEnvironment: 'node',
      setupFiles: ['<rootDir>/test/setup-env.cjs'],
      globalSetup: '<rootDir>/test/global-setup.cjs',
    },
  ],
};
