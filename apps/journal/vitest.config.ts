import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [cloudflareTest({wrangler: {configPath: "./wrangler.jsonc"}, remoteBindings: false,
    miniflare: {bindings: {
      TEST_MIGRATIONS: await readD1Migrations("./migrations"),
      JOURNAL_SITE_URL: "https://journal.example.org",
      JOURNAL_AGENT_TOKEN: "journal-agent-token-0000000000000000000",
      JOURNAL_PUBLISH_TOKEN: "journal-publisher-token-000000000000000",
    }},
  })],
  test: {testTimeout: 15000, hookTimeout: 15000},
});
