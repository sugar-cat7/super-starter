import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    categories: { correctness: 'error' },
    options: {
      typeAware: process.env.STARTER_CHECK_PHASE !== 'index',
      typeCheck: process.env.STARTER_CHECK_PHASE !== 'index',
    },
    plugins: ['typescript', 'react', 'import', 'vitest'],
    rules: {
      'no-debugger': 'error',
      'typescript/no-floating-promises':
        process.env.STARTER_CHECK_PHASE === 'index' ? 'off' : 'error',
      'typescript/no-explicit-any': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
    },
    ignorePatterns: [
      '**/node_modules/**',
      '**/dist/**',
      '**/target/**',
      '**/.cloudflare/**',
      '**/routeTree.gen.ts',
    ],
  },
  fmt: {
    singleQuote: true,
    ignorePatterns: [
      '**/node_modules/**',
      '**/dist/**',
      '**/target/**',
      '**/.cloudflare/**',
      '**/routeTree.gen.ts',
      'artifacts/**',
      // Machine-generated ownership hashes are validated by template checks.
      '.template.json',
    ],
  },
  test: {
    include: ['tools/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
    maxWorkers: 2,
  },
});
