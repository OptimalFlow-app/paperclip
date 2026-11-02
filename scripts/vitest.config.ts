import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "scripts",
    // Only TypeScript tests: the *.test.mjs files here run under `node --test`.
    include: ["__tests__/**/*.test.ts"],
  },
});
