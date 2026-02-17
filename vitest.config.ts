import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'happy-dom',
          environment: 'happy-dom',
          globals: true,
          setupFiles: ['./vitest.setup.ts'],
          include: ['src/**/*.test.{ts,tsx,js}', '__tests__/**/*.{test,spec}.{ts,tsx,js}', '!__tests__/gateway-*.test.ts'],
        },
      },
      {
        test: {
          name: 'node',
          environment: 'node',
          globals: true,
          setupFiles: ['./vitest.setup.ts'],
          include: ['__tests__/gateway-*.test.ts'],
        },
      },
    ],
  },
});
