import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {dirname,resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {parseArgs} from "node:util";

const directory=fileURLToPath(new URL("../",import.meta.url));
const quote=value=>`'${value.replaceAll("'","''")}'`;
const usage="node apps/journal/scripts/delete-article.mjs --remote|--local --article-id <UUID> [--expected-updated-at <ISO timestamp> --confirm]";

export function parseOptions(args){
  const {values}=parseArgs({args,options:{remote:{type:"boolean"},local:{type:"boolean"},"article-id":{type:"string"},"expected-updated-at":{type:"string"},confirm:{type:"boolean"},help:{type:"boolean"}},strict:true});
  if(values.help)return {help:true};
  if(!!values.remote===!!values.local)throw Error("Specify exactly one of --remote or --local.");
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(values["article-id"] ?? ""))throw Error("A valid --article-id is required.");
  const revision=values["expected-updated-at"];
  if(revision && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(revision) || !Number.isFinite(Date.parse(revision))))throw Error("Invalid --expected-updated-at.");
  if(values.confirm && !revision)throw Error("Preview the article first, then specify --expected-updated-at and --confirm.");
  return {remote:!!values.remote,articleId:values["article-id"],expectedUpdatedAt:revision,confirm:!!values.confirm};
}
function query(sql,remote){
  // No shell, no Journal credentials. Wrangler uses the operator's Cloudflare login.
  const wrangler=resolve(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),"bin/wrangler.js");
  const result=spawnSync(process.execPath,[wrangler,"d1","execute","DB",remote ? "--remote" : "--local","--command",sql,"--json"],
    {cwd:directory,encoding:"utf8",maxBuffer:4*1024*1024,timeout:60000});
  if(result.error || result.status!==0)throw Error("D1 operation failed. Check Wrangler authentication, migrations and article revision; inspect the article before retrying.");
  const responses=JSON.parse(result.stdout);
  if(!Array.isArray(responses) || responses.some(r=>!r.success))throw Error("D1 returned an unsuccessful result.");
  return responses.flatMap(r=>r.results ?? []);
}
export async function deleteArticle(options,execute=query){
  const {articleId,expectedUpdatedAt,remote,confirm}=options;
  const select=`SELECT id,title,status,updated_at AS updatedAt FROM articles WHERE id=${quote(articleId)}`;
  const [article]=await execute(select,remote);
  if(!article){
    const [receipt]=await execute(`SELECT article_id FROM journal_deletions WHERE article_id=${quote(articleId)}`,remote);
    if(receipt)return {deleted:true,alreadyDeleted:true,articleId};
    throw Error("Article not found.");
  }
  if(!confirm)return {deleted:false,target:remote ? "remote" : "local",article,next:"Re-run with this updatedAt as --expected-updated-at and --confirm to permanently delete."};
  if(article.updatedAt!==expectedUpdatedAt)throw Error("Article changed. Preview again before deleting.");
  await execute(`INSERT INTO journal_deletions(article_id,expected_updated_at,deleted_at) VALUES (${quote(articleId)},${quote(expectedUpdatedAt)},${quote(new Date().toISOString())})`,remote);
  if((await execute(select,remote)).length)throw Error("Deletion could not be verified. Inspect the article before retrying.");
  return {deleted:true,articleId};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const options=parseOptions(process.argv.slice(2));
    console.log(options.help ? usage : JSON.stringify(await deleteArticle(options),null,2));
  }catch(error){console.error(error instanceof Error ? error.message : "Deletion failed.");process.exitCode=1;}
}
