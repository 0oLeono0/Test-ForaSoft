import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          environment: 'node',
          include: ['shared/src/**/*.test.js'],
        },
      },
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/src/**/*.test.js'],
        },
      },
      // Настоящий сервер и socket.io-client (TDD §11.3). В npm test и test:coverage не входит:
      // запускается отдельно, npm run test:integration.
      {
        test: {
          name: 'server-integration',
          environment: 'node',
          include: ['server/test/integration/**/*.test.js'],
        },
      },
      {
        // JSX собирается esbuild-ом Vite: отдельный плагин React в тестах не нужен,
        // Fast Refresh работает только в dev-сервере (client/vite.config.js).
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['client/src/**/*.test.{js,jsx}'],
          setupFiles: ['client/src/test/setup.js'],
        },
      },
    ],
    // Пороги — TDD §11.7. Компоненты клиента не нормируются.
    coverage: {
      provider: 'v8',
      include: ['shared/src/**', 'server/src/**', 'client/src/**'],
      exclude: [
        '**/*.test.{js,jsx}',
        'client/src/test/**',
        // Точка входа процесса проверяется интеграционными и E2E-тестами (TDD §11.3, §11.4).
        'server/src/index.js',
      ],
      thresholds: {
        'shared/src/**': { lines: 95, branches: 90 },
        'server/src/**': { lines: 90, branches: 85 },
        'client/src/{services,state,utils}/**': { lines: 80, branches: 75 },
      },
    },
  },
});
