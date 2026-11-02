import {defineConfig} from "vitest/config";
import {cloudflareTest,readD1Migrations} from "@cloudflare/vitest-plugin";
import {fileURLToPath} from "node:url";
export default defineConfig({plugins:[cloudflareTest({wrangler:{configPath:"./wrangler.test.jsonc"},remoteBindings:false,
  miniflare:{bindings:{JOURNAL_AGENT_TOKEN:"journal-agent-token-0000000000000000000",TEST_MIGRATIONS:await readD1Migrations("../journal/migrations")},
    d1Databases:{TEST_DB:"report-journal-test"},
    workers:[{name:"niao-journal",compatibilityDate:"2026-10-27",compatibilityFlags:["nodejs_compat"],
      modulesRoot:fileURLToPath(new URL("../journal/build/",import.meta.url)),modules:[{type:"ESModule",path:fileURLToPath(new URL("../journal/build/index.js",import.meta.url))}],
      d1Databases:{DB:"report-journal-test"},bindings:{JOURNAL_SITE_URL:"https://journal.example.org",JOURNAL_AGENT_TOKEN:"journal-agent-token-0000000000000000000",JOURNAL_PUBLISH_TOKEN:"journal-publisher-token-000000000000000"}
    }]}})],test:{testTimeout:20000,hookTimeout:20000}});
