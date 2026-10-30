import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { DocumentService } from "./documents";
import { SemanticIndex, type SemanticBindings } from "./semantic";
import { ApiError } from "./validation";

const origin = "https://scrapbox.io";
const projectSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const pageId = z.string().regex(/^[a-f0-9]{24}$/);
const summarySchema = z.object({id:pageId,title:z.string().min(1).max(1024),updated:z.number().int().nonnegative()});
const pageSchema = summarySchema.extend({created:z.number().int().nonnegative(),lines:z.array(z.object({text:z.string()})).max(20000),commitId:z.string().optional()});
export const jobSchema = z.object({project:projectSchema,pageUrl:z.string().max(2048),pageId:pageId.optional(),version:z.string().max(256)});
export type SyncJob = z.infer<typeof jobSchema>;
export interface SyncBindings extends SemanticBindings {
  DB:D1Database; COSENSE_SYNC_QUEUE?:Queue<SyncJob>;
  COSENSE_PROJECT_NAME?:string; COSENSE_SYNC_ENABLED?:string; COSENSE_FEED_URL?:string;
}
function failureCode(error:unknown) {
  const message=error instanceof Error?error.message:"";
  return /^(source_http_\d{3}|source_too_large|semantic_pending|source_snapshot_superseded|page_identity_changed|sync_busy|wrong_project|enqueue_in_progress)$/.test(message)?message:"sync_failed";
}
const log = (event:string, fields:Record<string,unknown>={}) => console.log(JSON.stringify({event:`cosense.${event}`,...fields}));
export function project(env:SyncBindings) { return projectSchema.parse(env.COSENSE_PROJECT_NAME ?? "udzura-lofi-memo"); }
export function pageTitle(url:string, name:string) {
  const parsed = new URL(url);
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("invalid_page_url");
  const parts=parsed.pathname.split("/");
  if (parts.length!==3 || parts[1]!==name || !parts[2]) throw new Error("invalid_page_url");
  return decodeURIComponent(parts[2]).replace(/_/g," ");
}
const urlFor = (name:string,title:string) => `${origin}/${name}/${encodeURIComponent(title)}`;
export function parseFeed(xml:string,name:string):SyncJob[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml)!==true) throw new Error("invalid_feed");
  const data = new XMLParser({ignoreAttributes:true,parseTagValue:false,trimValues:true,processEntities:true}).parse(xml);
  if (!data?.rss?.channel || typeof data.rss.channel !== "object") throw new Error("invalid_feed");
  const items=data.rss.channel.item ?? [];
  const jobs=new Map<string,SyncJob>();
  for (const item of Array.isArray(items)?items:[items]) {
    if (typeof item.link!=="string" || typeof item.title!=="string") throw new Error("invalid_feed_entry");
    const title=pageTitle(item.link,name), pageUrl=urlFor(name,title);
    // RSS GUIDs are URLs, never stable page IDs. A missing date is rechecked hourly.
    const date=Date.parse(item.pubDate);
    if (item.pubDate && !Number.isFinite(date)) throw new Error("invalid_feed_date");
    const version=Number.isFinite(date)?String(date):String(Math.floor(Date.now()/3600000));
    const prior=jobs.get(pageUrl);
    if (!prior || Number(prior.version)<Number(version)) jobs.set(pageUrl,{project:name,pageUrl,version});
  }
  if (jobs.size>100) throw new Error("feed_too_large");
  return [...jobs.values()];
}
async function readSource(url:string,fetcher:typeof fetch,limit:number) {
  const response=await fetcher(url,{redirect:"manual",signal:AbortSignal.timeout(15000),headers:{Accept:"application/json, application/rss+xml"}});
  if (!response.ok) throw new Error(`source_http_${response.status}`);
  const reader=response.body!.getReader(),decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:false});
  let size=0,text="";
  try { while(true) {const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw new Error("source_too_large");text+=decoder.decode(value,{stream:true});} }
  finally {await reader.cancel();reader.releaseLock();}
  return text+decoder.decode();
}
export class CosenseSync {
  constructor(private env:SyncBindings,private fetcher:typeof fetch=fetch) {}
  private async enqueue(job:SyncJob, force=false) {
    const queue=this.env.COSENSE_SYNC_QUEUE;
    if (!queue) throw new Error("sync_queue_not_configured");
    const db=this.env.DB,now=Date.now();
    await db.prepare(`INSERT INTO cosense_discovery(project,page_url,version) VALUES(?,?,?)
      ON CONFLICT(project,page_url) DO UPDATE SET version=excluded.version,queued_until=0
      WHERE CAST(excluded.version AS INTEGER)>CAST(cosense_discovery.version AS INTEGER)`)
      .bind(job.project,job.pageUrl,job.version).run();
    const claim=await db.prepare(`UPDATE cosense_discovery SET queued_until=?
      WHERE project=? AND page_url=? AND version=? AND (acknowledged_version IS NULL OR acknowledged_version<>version OR ?)
      AND (queued_until<=? OR (acknowledged_version=version AND ?)) RETURNING page_url`).bind(now+120000,job.project,job.pageUrl,job.version,force?1:0,now,force?1:0).first();
    if (!claim) {
      const row=await db.prepare("SELECT version,sent_version,acknowledged_version FROM cosense_discovery WHERE project=? AND page_url=?").bind(job.project,job.pageUrl).first<{version:string;sent_version:string;acknowledged_version:string}>();
      if(row && (Number(row.version)>Number(job.version) || row.sent_version===job.version || (!force && row.acknowledged_version===job.version)))return false;
      throw new Error("enqueue_in_progress");
    }
    // Crash after send may duplicate delivery; crash before send expires the short claim.
    try {await queue.send(job);}
    catch(error) {await db.prepare("UPDATE cosense_discovery SET queued_until=0 WHERE project=? AND page_url=? AND version=?").bind(job.project,job.pageUrl,job.version).run();throw error;}
    await db.prepare(`UPDATE cosense_discovery SET queued_until=?,sent_version=version WHERE project=? AND page_url=? AND version=?`)
      .bind(now+7200000,job.project,job.pageUrl,job.version).run();
    log("enqueued");return true;
  }
  async poll() {
    if (this.env.COSENSE_SYNC_ENABLED!=="true") return {enabled:false};
    const name=project(this.env),db=this.env.DB;
    log("poll_start");
    try {
      const feed=new URL(this.env.COSENSE_FEED_URL ?? `${origin}/api/feed/${name}`);
      if (feed.origin!==origin || feed.pathname!==`/api/feed/${name}` || feed.search || feed.hash || feed.username || feed.password) throw new Error("invalid_feed_url");
      const jobs=parseFeed(await readSource(feed.href,this.fetcher,1024*1024),name);
      let enqueued=0;
      // Persist all discoveries before bounded dispatch; RSS may rotate before the next poll.
      await db.prepare(`INSERT INTO cosense_discovery(project,page_url,version)
        SELECT ?,json_extract(value,'$.pageUrl'),json_extract(value,'$.version') FROM json_each(?) WHERE true
        ON CONFLICT(project,page_url) DO UPDATE SET version=excluded.version,queued_until=0
        WHERE CAST(excluded.version AS INTEGER)>CAST(cosense_discovery.version AS INTEGER)`)
        .bind(name,JSON.stringify(jobs)).run();
      const pending=await db.prepare(`SELECT page_url,version FROM cosense_discovery WHERE project=?
        AND (acknowledged_version IS NULL OR acknowledged_version<>version) AND queued_until<=?
        ORDER BY CAST(version AS INTEGER),page_url LIMIT 8`).bind(name,Date.now()).all<{page_url:string;version:string}>();
      for(const row of pending.results) if(await this.enqueue({project:name,pageUrl:row.page_url,version:row.version}))enqueued++;
      await db.prepare(`INSERT INTO cosense_poll(project,last_success,entries) VALUES(?,?,?)
        ON CONFLICT(project) DO UPDATE SET last_success=excluded.last_success,entries=excluded.entries,last_error=NULL`)
        .bind(name,new Date().toISOString(),jobs.length).run();
      log("poll_complete",{entries:jobs.length,enqueued});return {entries:jobs.length,enqueued};
    } catch {
      await db.prepare(`INSERT INTO cosense_poll(project,last_error) VALUES(?,'poll_failed')
        ON CONFLICT(project) DO UPDATE SET last_error='poll_failed'`).bind(name).run();
      log("poll_failed");throw new Error("cosense_poll_failed");
    }
  }
  async consume(input:unknown) {
    const job=jobSchema.parse(input);
    if(job.project!==project(this.env)) throw new Error("wrong_project");
    const title=pageTitle(job.pageUrl,job.project);
    const load=async()=>pageSchema.parse(JSON.parse(await readSource(`${origin}/api/pages/${job.project}/${encodeURIComponent(title)}`,this.fetcher,512*1024)));
    let page=await load();
    if(job.pageId && page.id!==job.pageId) throw new Error("page_identity_changed");
    const db=this.env.DB,token=crypto.randomUUID();
    await db.prepare("INSERT OR IGNORE INTO cosense_pages(project,page_id) VALUES(?,?)").bind(job.project,page.id).run();
    const lock=await db.prepare(`UPDATE cosense_pages SET lease_token=?,lease_until=? WHERE project=? AND page_id=? AND lease_until<? RETURNING page_id`)
      .bind(token,Date.now()+120000,job.project,page.id,Date.now()).first();
    if(!lock) throw new Error("sync_busy");
    try {
      // Refetch under the per-page lease; stale queued versions never supply body text.
      const latest=await load();if(latest.id!==page.id)throw new Error("page_identity_changed");page=latest;
      const body=page.lines.map(line=>line.text).join("\n") || page.title;
      const hash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([page.title,body]))))].map(n=>n.toString(16).padStart(2,"0")).join("");
      const documents=new DocumentService(db),sourceId=`${job.project}/${page.id}`;
      const existing=await db.prepare("SELECT id, title, body, updated_at FROM documents WHERE source='cosense' AND source_id=?").bind(sourceId).first<{id:string;title:string;body:string;updated_at:string}>();
      const updated=new Date(page.updated*1000).toISOString();
      const unchanged=existing && existing.title===page.title && existing.body===body && existing.updated_at===updated;
      const doc=unchanged ? existing : await documents.upsert({source:"cosense",source_id:sourceId,title:page.title,body,
        url:urlFor(job.project,page.title),created_at:new Date(page.created*1000).toISOString(),updated_at:updated,
        metadata:{project:job.project,page_id:page.id,format:"scrapbox",importer_version:1,content_hash:hash,...(page.commitId?{commit_id:page.commitId}:{})}},true);
      if(doc.updated_at!==updated)throw new Error("source_snapshot_superseded");
      const index=new SemanticIndex(db,this.env);
      const state=await index.sync(doc.id);
      if(index.configured && (state.status!=="submitted" || state.error_code))throw new Error("semantic_pending");
      await db.batch([
        db.prepare(`UPDATE cosense_pages SET document_id=?,content_hash=?,source_updated=?,last_success=?,last_error=NULL WHERE project=? AND page_id=? AND lease_token=?`)
          .bind(doc.id,hash,page.updated,new Date().toISOString(),job.project,page.id,token),
        db.prepare("UPDATE cosense_discovery SET acknowledged_version=? WHERE project=? AND page_url=? AND version=?").bind(job.version,job.project,job.pageUrl,job.version),
      ]);
      log(unchanged?"unchanged":"indexed",{pageId:page.id,semantic:state.status});
    } catch(error) {
      const code=failureCode(error);
      await db.prepare("UPDATE cosense_pages SET last_error=? WHERE project=? AND page_id=? AND lease_token=?").bind(code,job.project,page.id,token).run();
      log("failed",{code,pageId:page.id});
      throw new Error(code);
    } finally { await db.prepare("UPDATE cosense_pages SET lease_token=NULL,lease_until=0 WHERE project=? AND page_id=? AND lease_token=?").bind(job.project,page.id,token).run(); }
  }
  async backfill(input:unknown) {
    const {dryRun,reset}=z.object({dryRun:z.boolean().default(false),reset:z.boolean().default(false)}).strict().parse(input);
    const name=project(this.env),db=this.env.DB;
    if(!dryRun)await db.prepare("INSERT OR IGNORE INTO cosense_backfill(project) VALUES(?)").bind(name).run();
    const row=await db.prepare("SELECT next_skip FROM cosense_backfill WHERE project=?").bind(name).first<{next_skip:number}>();
    const skip=reset?0:row?.next_skip??0,limit=5;
    const data=z.object({projectName:z.literal(name),skip:z.literal(skip),count:z.number().int().nonnegative(),pages:z.array(summarySchema).max(limit)})
      .parse(JSON.parse(await readSource(`${origin}/api/pages/${name}?skip=${skip}&limit=${limit}`,this.fetcher,512*1024)));
    if(!data.pages.length && skip<data.count)throw new Error("incomplete_page_list");
    let enqueued=0;
    for(const page of data.pages) {
      if(dryRun)continue;
      const old=await db.prepare("SELECT title,updated_at FROM documents WHERE source='cosense' AND source_id=?").bind(`${name}/${page.id}`).first<{title:string;updated_at:string}>();
      const pending=await db.prepare(`SELECT status FROM semantic_jobs WHERE document_id=(SELECT id FROM documents WHERE source='cosense' AND source_id=?)`).bind(`${name}/${page.id}`).first<{status:string}>();
      if(old?.title===page.title && old.updated_at===new Date(page.updated*1000).toISOString() && (!this.env.VECTORIZE || pending?.status==='submitted'))continue;
      if(await this.enqueue({project:name,pageUrl:urlFor(name,page.title),pageId:page.id,version:String(page.updated*1000)},true))enqueued++;
    }
    const next=skip+data.pages.length;
    if(!dryRun)await db.prepare("UPDATE cosense_backfill SET next_skip=?,total=?,updated_at=? WHERE project=? AND next_skip=?")
      .bind(next,data.count,new Date().toISOString(),name,row?.next_skip??0).run();
    log("backfill",{skip,next,total:data.count,enqueued,dryRun});
    return {skip,next_skip:next,total:data.count,has_more:next<data.count,enqueued,dryRun};
  }
  async health() {
    const name=project(this.env);
    return {project:name,enabled:this.env.COSENSE_SYNC_ENABLED==='true',
      poll:await this.env.DB.prepare("SELECT * FROM cosense_poll WHERE project=?").bind(name).first(),
      backfill:await this.env.DB.prepare("SELECT * FROM cosense_backfill WHERE project=?").bind(name).first(),
      pages:await this.env.DB.prepare("SELECT COUNT(*) total,SUM(last_error IS NOT NULL) failed FROM cosense_pages WHERE project=?").bind(name).first()};
  }
}
export async function consumeBatch(batch:MessageBatch<unknown>,env:SyncBindings) {
  for(const message of batch.messages) {
    try {await new CosenseSync(env).consume(message.body);message.ack();}
    catch(error) {log("retry",{attempt:message.attempts,code:failureCode(error)});message.retry({delaySeconds:Math.min(3600,60*2**Math.min(message.attempts,6))});}
  }
}
