import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Bare "@blacklabel/<pkg>" -> that package's source entry point.
      // (Subpath imports are intentionally NOT supported — import from the package root only.)
      {
        find: /^@blacklabel\/([^/]+)$/,
        replacement: path.resolve(root, 'packages/$1/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
    ],
  },
});
