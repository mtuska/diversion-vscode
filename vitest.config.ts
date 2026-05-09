import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    // Allow our `.js` import suffixes (Node16 module resolution) to resolve
    // to the `.ts` sources during testing.
    extensions: ['.ts', '.js'],
  },
});
