import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    miniflare: {bindings: {NIAO_TOKEN: "test-only-token-000000000000000000000000", CF_ACCOUNT_ID: "", CF_ANALYTICS_TOKEN: ""}},
  })],
  test: {testTimeout: 15_000, hookTimeout: 15_000},
});
