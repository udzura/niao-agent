import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: {configPath: "./wrangler.jsonc"}, remoteBindings: false,
    miniflare: {bindings: {
      TEST_MIGRATIONS: await readD1Migrations("./migrations"),
      PAST_LOGS_ADMIN_TOKEN: "test-admin-token-0000000000000000000000",
      PAST_LOGS_READ_TOKEN: "test-reader-token-000000000000000000000",
    }},
  })],
  test: {testTimeout: 15_000, hookTimeout: 15_000},
});
