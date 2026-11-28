import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Behavioral test runner for the terminal surfaces. jsdom gives us window/WebSocket/fetch seams so the
// gatewayWS + liveMeetings stores and the meeting.tsx action map can be driven without Next/the browser.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    // Multi-step jsdom + Testing Library role queries can exceed 5s under CI CPU contention.
    testTimeout: 15_000,
    // Use jsdom's origin-scoped Storage rather than Node's process-level Web Storage globals.
    execArgv: ["--no-experimental-webstorage"],
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx"],
  },
});
