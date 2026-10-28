import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    miniflare: {
      workers: [{
        name: "niao-ruby-runner",
        compatibilityDate: "2026-10-27",
        modulesRoot: fileURLToPath(new URL("../ruby-runner/build/",import.meta.url)),
        modules: [
          {type:"ESModule",path:fileURLToPath(new URL("../ruby-runner/build/index.js",import.meta.url))},
          ...readdirSync(new URL("../ruby-runner/build/",import.meta.url)).filter(name=>name.endsWith(".wasm")).map(name=>({type:"CompiledWasm" as const,path:fileURLToPath(new URL(`../ruby-runner/build/${name}`,import.meta.url))})),
        ],
      }],
      serviceBindings: {RUBY_RUNNER:"niao-ruby-runner"},
      bindings: {NIAO_TOKEN: "test-only-token-000000000000000000000000", CF_ACCOUNT_ID: "", CF_ANALYTICS_TOKEN: ""}},
  })],
  test: {testTimeout: 15_000, hookTimeout: 15_000},
});
