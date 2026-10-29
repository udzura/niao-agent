import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    miniflare: {
      d1Databases: {PAST_LOGS_TEST_DB: "past-logs-integration"},
      workers: [{
        name: "niao-past-logs",
        compatibilityDate: "2026-10-27", compatibilityFlags: ["nodejs_compat"],
        modulesRoot: fileURLToPath(new URL("../past-logs/build/", import.meta.url)),
        modules: [{type: "ESModule", path: fileURLToPath(new URL("../past-logs/build/index.js", import.meta.url))}],
        d1Databases: {DB: "past-logs-integration"},
        bindings: {PAST_LOGS_ADMIN_TOKEN: "test-admin-token-0000000000000000000000", PAST_LOGS_READ_TOKEN: "test-reader-token-000000000000000000000"},
      }, {
        name: "niao-ruby-runner",
        compatibilityDate: "2026-10-27",
        modulesRoot: fileURLToPath(new URL("../ruby-runner/build/",import.meta.url)),
        modules: [
          {type:"ESModule",path:fileURLToPath(new URL("../ruby-runner/build/index.js",import.meta.url))},
          ...readdirSync(new URL("../ruby-runner/build/",import.meta.url)).filter(name=>name.endsWith(".wasm")).map(name=>({type:"CompiledWasm" as const,path:fileURLToPath(new URL(`../ruby-runner/build/${name}`,import.meta.url))})),
        ],
      }],
      serviceBindings: {RUBY_RUNNER:"niao-ruby-runner", PAST_LOGS_TEST: "niao-past-logs"},
      bindings: {TEST_PAST_LOGS_MIGRATIONS: await readD1Migrations("../past-logs/migrations"), NIAO_TOKEN: "test-only-token-000000000000000000000000", CF_ACCOUNT_ID: "", CF_ANALYTICS_TOKEN: ""}},
  })],
  test: {testTimeout: 15_000, hookTimeout: 15_000},
});
