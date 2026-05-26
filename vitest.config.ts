import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup/vitest.setup.ts"],
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.tsx"],
    globals: true,
    css: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/lib/files.ts",
        "src/lib/number.ts",
        "src/lib/media.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      exclude: [
        "dist/**",
      ],
    },
  },
});
