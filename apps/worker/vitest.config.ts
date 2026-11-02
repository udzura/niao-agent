import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import {forecastFixture, locationFixture} from "./test/fixtures/weather";
import {webArticle,publicDnsFixture} from "./test/fixtures/web";
import {kaniMarkdown,kaniIndex,kaniFeed} from "./test/fixtures/kani";
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    miniflare: {
      d1Databases: {PAST_LOGS_TEST_DB: "past-logs-integration", JOURNAL_TEST_DB: "journal-integration"},
      workers: [{
        name: "niao-tools-misc", compatibilityDate: "2026-10-27", compatibilityFlags:["nodejs_compat"],
        serviceBindings: {BROWSER:"niao-browser-test-fixture"},
        // Only external HTTP and remote Browser Run are replaced: the actual production Worker and RPC run.
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.origin === "https://cloudflare-dns.com" && url.pathname === "/dns-query" && url.searchParams.get("name") === "articles.example.org")
            return Response.json(publicDnsFixture(url.searchParams.get("type")!));
          if (url.origin === "https://articles.example.org") {
            if (request.headers.has("Authorization") || request.headers.has("Cookie")) throw new Error("Credential forwarded");
            if (url.pathname === "/redirect") return new Response(null,{status:302,headers:{Location:"/posts/entry"}});
            return new Response(webArticle(),{headers:{"Content-Type":"text/html; charset=utf-8"}});
          }
          if (url.origin === "https://geocoding-api.open-meteo.com") return Response.json(locationFixture);
          if (url.origin === "https://api.open-meteo.com") return Response.json(forecastFixture(Number(url.searchParams.get("forecast_days"))));
          if (url.origin === "https://yota.kani.show") {
            if (url.pathname === "/feed.xml") return new Response(kaniFeed,{headers:{"Content-Type":"application/rss+xml"}});
            if (request.headers.get("Accept") !== "text/markdown") throw new Error("Missing markdown negotiation");
            return new Response(url.pathname === "/" ? kaniIndex : kaniMarkdown,{headers:{"Content-Type":"text/markdown"}});
          }
          throw new Error("Unexpected external request");
        },
        modulesRoot: fileURLToPath(new URL("../tools-misc/build/", import.meta.url)),
        modules: [{type:"ESModule",path:fileURLToPath(new URL("../tools-misc/build/index.js",import.meta.url))}],
      }, {
        name: "niao-journal", compatibilityDate: "2026-10-27", compatibilityFlags: ["nodejs_compat"],
        modulesRoot: fileURLToPath(new URL("../journal/build/", import.meta.url)),
        modules: [{type: "ESModule", path: fileURLToPath(new URL("../journal/build/index.js", import.meta.url))}],
        d1Databases: {DB: "journal-integration"},
        bindings: {JOURNAL_SITE_URL: "https://journal.example.org", JOURNAL_AGENT_TOKEN: "journal-agent-token-0000000000000000000",
          JOURNAL_PUBLISH_TOKEN: "journal-publisher-token-000000000000000"},
      }, {
        name: "niao-browser-test-fixture", compatibilityDate: "2026-10-27",
        modules: [{type:"ESModule",path:fileURLToPath(new URL("./test/fixtures/browser-worker.mjs",import.meta.url))}],
      }, {
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
      serviceBindings: {TOOLS_MISC:"niao-tools-misc", RUBY_RUNNER:"niao-ruby-runner", PAST_LOGS_TEST: "niao-past-logs", JOURNAL: "niao-journal"},
      bindings: {TEST_PAST_LOGS_MIGRATIONS: await readD1Migrations("../past-logs/migrations"),
        TEST_JOURNAL_MIGRATIONS: await readD1Migrations("../journal/migrations"),
        JOURNAL_AGENT_TOKEN: "journal-agent-token-0000000000000000000", JOURNAL_PUBLISH_TOKEN: "journal-publisher-token-000000000000000",
        NIAO_TOKEN: "test-only-token-000000000000000000000000", CF_ACCOUNT_ID: "", CF_ANALYTICS_TOKEN: ""}},
  })],
  test: {testTimeout: 15_000, hookTimeout: 15_000},
});
