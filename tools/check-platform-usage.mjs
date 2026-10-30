// Read-only check using exactly the same queries/parsers as the deployed Worker.
// Never prints credentials. Run from any directory: node tools/check-platform-usage.mjs
import {readFile} from "node:fs/promises";
import {parseEnv} from "node:util";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";

const root = new URL("../", import.meta.url);
let local = {};
try { local = parseEnv(await readFile(new URL("apps/worker/.dev.vars", root), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const env = Object.fromEntries(["CF_ACCOUNT_ID", "CF_ANALYTICS_TOKEN"].map(key => [key, process.env[key] ?? local[key]]));
if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
  console.error("Set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN in apps/worker/.dev.vars or the environment.");
  process.exit(1);
}
const bundle = await build({entryPoints: [fileURLToPath(new URL("apps/worker/src/platform-usage.ts", root))],
  bundle: true, write: false, format: "esm", platform: "node"});
const {PlatformAnalytics} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const snapshot = await new PlatformAnalytics(env).today();
console.log(JSON.stringify(snapshot, null, 2));
if ([snapshot.workers, snapshot.durableObjects, snapshot.plan].some(value => value.status !== "available")) process.exitCode = 1;
