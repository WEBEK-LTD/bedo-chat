import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS uses TypeScript's legacy decorators with metadata, exactly as the tsc build emits them.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
  },
});
