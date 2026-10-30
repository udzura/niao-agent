import {env,applyD1Migrations,reset} from 'cloudflare:test';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import worker,{type Env} from '../src/index';
import {CosenseSync,parseFeed,consumeBatch,type SyncBindings} from '../src/cosense-sync';
import {DocumentService} from '../src/documents';
import {EmbeddingFixture,VectorFixture} from './semantic-fixtures';
const base=env as unknown as Env & {TEST_MIGRATIONS:any[]};
const project='test-project',id='a'.repeat(24),date='Fri, 30 Oct 2026 08:02:03 GMT';
const url=(title:string)=>`https://scrapbox.io/${project}/${encodeURIComponent(title)}`;
const feed=(title='日本語 Ruby',at=date)=>`<rss version="2.0"><channel><item><title><![CDATA[${title}]]></title><link>${url(title)}</link><guid>not-a-page-id</guid><pubDate>${at}</pubDate></item></channel></rss>`;
const job=(title='日本語 Ruby',version='1')=>({project,pageUrl:url(title),version});
let page:any,bindings:SyncBindings,sent:any[],failSend:boolean,failSource:boolean;
let embed:EmbeddingFixture,vector:VectorFixture;
let source:typeof fetch;
beforeEach(async()=>{
 await applyD1Migrations(base.DB,base.TEST_MIGRATIONS);
 page={id,title:'日本語 Ruby',updated:1793347323,created:1700000000,lines:[{text:'日本語 Ruby 検索 本文'}]};
 sent=[];failSend=false;failSource=false;embed=new EmbeddingFixture();vector=new VectorFixture();
 bindings={DB:base.DB,COSENSE_PROJECT_NAME:project,COSENSE_SYNC_ENABLED:'true',COSENSE_SYNC_QUEUE:{send:async(body:any)=>{if(failSend)throw Error('queue down');sent.push(body);}} as any};
 source=vi.fn(async(input:any)=>{if(failSource)return new Response('down',{status:503});return new Response(String(input).includes('/api/feed/')?feed():JSON.stringify(page));}) as typeof fetch;
});
afterEach(async()=>{vi.unstubAllGlobals();await reset();});
describe('Cosense RSS and queue synchronization',()=>{
 it('parses CDATA, Japanese URLs and dates without treating GUID as page ID; deduplicates entries',()=>{
  const xml=feed().replace('</channel>',feed().match(/<item>.*<\/item>/)![0]+'</channel>');
  const jobs=parseFeed(xml,project);expect(jobs).toHaveLength(1);expect(jobs[0].pageId).toBeUndefined();expect(jobs[0].pageUrl).toBe(url('日本語 Ruby'));
  for(const xml of ['<rss>', '<!DOCTYPE rss><rss/>',feed().replace('scrapbox.io','evil.test'),feed('Ruby','invalid')])expect(()=>parseFeed(xml,project)).toThrow();
 });
 it('enqueues new/changed entries once and only acknowledges after consumption',async()=>{
  const sync=new CosenseSync(bindings,source);
  expect(await sync.poll()).toMatchObject({enqueued:1});expect(await sync.poll()).toMatchObject({enqueued:0});
  await sync.consume(sent[0]);expect(await sync.poll()).toMatchObject({enqueued:0});
  const newer=vi.fn(async()=>new Response(feed('日本語 Ruby','Sat, 31 Oct 2026 08:02:03 GMT'))) as typeof fetch;
  expect(await new CosenseSync(bindings,newer).poll()).toMatchObject({enqueued:1});
  expect((await sync.health()).poll).toMatchObject({last_error:null});
 });
 it('retains undispatched discoveries when they rotate out of RSS',async()=>{
  const items=Array.from({length:9},(_,i)=>feed(`記事${i}`).match(/<item>.*<\/item>/)![0]).join('');
  let xml=`<rss><channel>${items}</channel></rss>`;
  const sync=new CosenseSync(bindings,async()=>new Response(xml));
  expect(await sync.poll()).toMatchObject({entries:9,enqueued:8});
  xml='<rss><channel><title>empty</title></channel></rss>';
  expect(await sync.poll()).toMatchObject({entries:0,enqueued:1});expect(sent.length).toBe(9);
 });
 it('does not advance a backfill over an uncertain unsent reservation',async()=>{
  const item={id,title:'reserved',updated:1};
  await base.DB.prepare('INSERT INTO cosense_discovery(project,page_url,version,queued_until) VALUES(?,?,?,?)').bind(project,url('reserved'),'1000',Date.now()+60000).run();
  const sync=new CosenseSync(bindings,async()=>Response.json({projectName:project,skip:0,count:1,pages:[item]}));
  await expect(sync.backfill({})).rejects.toThrow('enqueue_in_progress');
  expect(await base.DB.prepare('SELECT next_skip FROM cosense_backfill').first()).toEqual({next_skip:0});
 });
 it('skips already indexed articles during an explicit full backfill',async()=>{
  const sync=new CosenseSync(bindings,source);await sync.consume(job());
  const listing=async()=>Response.json({projectName:project,skip:0,count:1,pages:[{id,title:page.title,updated:page.updated}]});
  expect(await new CosenseSync(bindings,listing).backfill({})).toMatchObject({enqueued:0,has_more:false});
  expect(sent.length).toBe(0);
 });
 it('allows backfill to restore an acknowledged article deleted from the local archive',async()=>{
  const sync=new CosenseSync(bindings,source);await sync.poll();await sync.consume(sent[0]);
  const doc=await base.DB.prepare("SELECT id FROM documents").first<{id:string}>();
  await new DocumentService(base.DB).delete(doc!.id);
  const listing=async()=>Response.json({projectName:project,skip:0,count:1,pages:[{id,title:page.title,updated:page.updated}]});
  expect(await new CosenseSync(bindings,listing).backfill({})).toMatchObject({enqueued:1});
  await sync.consume(sent.at(-1));expect(await base.DB.prepare('SELECT COUNT(*) n FROM documents').first()).toEqual({n:1});
 });
 it('records polling failures without advancing success or losing enqueue candidates',async()=>{
  failSource=true;await expect(new CosenseSync(bindings,source).poll()).rejects.toThrow();
  expect(await base.DB.prepare('SELECT last_success,last_error FROM cosense_poll').first()).toMatchObject({last_success:null,last_error:'poll_failed'});
  failSource=false;failSend=true;await expect(new CosenseSync(bindings,source).poll()).rejects.toThrow();
  failSend=false;await base.DB.prepare('UPDATE cosense_discovery SET queued_until=0').run();
  expect(await new CosenseSync(bindings,source).poll()).toMatchObject({enqueued:1});
 });
 it('preserves identity through renames, original text and dates, and replaces FTS terms',async()=>{
  const sync=new CosenseSync(bindings,source);await sync.consume(job());
  const docs=new DocumentService(base.DB),first=(await docs.search({query:'日本語'}))[0];
  page.title='改名後';page.updated++;page.lines=[{text:'新しい文章\n code indentation'}];
  await sync.consume(job('改名後','2'));
  expect((await docs.get(first.id))!).toMatchObject({title:'改名後',body:'新しい文章\n code indentation',source_id:`${project}/${id}`,url:url('改名後')});
  expect(await docs.search({query:'日本語'})).toHaveLength(0);expect(await docs.search({query:'文章'})).toHaveLength(1);
  expect(await base.DB.prepare('SELECT COUNT(*) n FROM documents').first()).toEqual({n:1});
 });
 it('does not embed unchanged imports twice and keeps Vectorize retries actionable after D1 commits',async()=>{
  Object.assign(bindings,{AI:embed.ai,VECTORIZE:vector.binding});const sync=new CosenseSync(bindings,source);
  vector.failUpsert=true;await expect(sync.consume(job())).rejects.toThrow();
  expect(await base.DB.prepare('SELECT COUNT(*) n FROM documents').first()).toEqual({n:1});
  expect(await base.DB.prepare('SELECT status FROM semantic_jobs').first()).toEqual({status:'pending'});
  vector.failUpsert=false;await sync.consume(job());const calls=embed.calls.length;
  await sync.consume(job());expect(embed.calls.length).toBe(calls);
  page.updated++;page.lines=[{text:'Changed Ruby document'}];await sync.consume(job());
  expect(vector.deletes.flat().length).toBeGreaterThan(0);
 });
 it('retries API failures; refuses a replaced page and concurrent page leases',async()=>{
  const sync=new CosenseSync(bindings,source);failSource=true;await expect(sync.consume(job())).rejects.toThrow();
  failSource=false;await expect(sync.consume({...job(),pageId:'b'.repeat(24)})).rejects.toThrow('page_identity_changed');
  await sync.consume(job());await base.DB.prepare('UPDATE cosense_pages SET lease_until=?').bind(Date.now()+60000).run();
  await expect(sync.consume(job())).rejects.toThrow('sync_busy');
 });
 it('fences an older source snapshot even when a separate REST import wrote a newer version',async()=>{
  const sync=new CosenseSync(bindings,source);await sync.consume(job());
  const docs=new DocumentService(base.DB),old=(await docs.search({query:'Ruby'}))[0],doc=(await docs.get(old.id))!;
  const {id:_,indexed_at:__,...input}=doc;
  await docs.upsert({...input,body:'新しい REST 本文',updated_at:new Date((page.updated+5)*1000).toISOString()});
  await expect(sync.consume(job())).rejects.toThrow();expect((await docs.get(old.id))!.body).toBe('新しい REST 本文');
 });
 it('backfills one bounded page, resumes, skips unchanged documents and supports dry-run',async()=>{
  const pages=Array.from({length:7},(_,i)=>({id:i.toString(16).padStart(24,'0'),title:`記事${i}`,updated:page.updated}));
  const listing=vi.fn(async(input:any)=>{const skip=Number(new URL(input).searchParams.get('skip'));return Response.json({projectName:project,skip,count:7,pages:pages.slice(skip,skip+5)});}) as typeof fetch;
  const sync=new CosenseSync(bindings,listing);
  expect(await sync.backfill({dryRun:true})).toMatchObject({next_skip:5,has_more:true,enqueued:0});
  expect(await base.DB.prepare('SELECT * FROM cosense_backfill').first()).toBeNull();
  expect(await sync.backfill({})).toMatchObject({next_skip:5,enqueued:5});
  expect(await sync.backfill({})).toMatchObject({next_skip:7,enqueued:2,has_more:false});
  expect(await sync.backfill({reset:true})).toMatchObject({enqueued:0});expect(sent.length).toBe(7);
 });
 it('does not advance backfill on partial queue failure and can re-run without duplicates',async()=>{
  let n=0;bindings.COSENSE_SYNC_QUEUE={send:async(body:any)=>{if(++n===2)throw Error('down');sent.push(body);}} as any;
  const listing=async()=>Response.json({projectName:project,skip:0,count:2,pages:[{id,title:'a',updated:1},{id:'b'.repeat(24),title:'b',updated:1}]});
  const sync=new CosenseSync(bindings,listing as typeof fetch);await expect(sync.backfill({})).rejects.toThrow();
  expect(await base.DB.prepare('SELECT next_skip FROM cosense_backfill').first()).toEqual({next_skip:0});
  await base.DB.prepare('UPDATE cosense_discovery SET queued_until=0 WHERE page_url=?').bind(url('b')).run();
  expect(await sync.backfill({})).toMatchObject({enqueued:1,next_skip:2});expect(sent.length).toBe(2);
 });
 it('acknowledges only successful messages; retries failures individually',async()=>{
  vi.stubGlobal('fetch',source);
  const first={body:job(),ack:vi.fn(),retry:vi.fn(),attempts:1};const second={body:{...job(),project:'wrong'},ack:vi.fn(),retry:vi.fn(),attempts:2};
  await consumeBatch({messages:[first,second]} as any,bindings);
  expect(first.ack).toHaveBeenCalledOnce();expect(first.retry).not.toHaveBeenCalled();expect(second.ack).not.toHaveBeenCalled();expect(second.retry).toHaveBeenCalledWith({delaySeconds:240});
 });
 it('protects health and backfill with the existing admin credentials',async()=>{
  for(const path of ['/api/cosense-sync','/api/cosense-sync/backfill']) {
   const method=path.endsWith('backfill')?'POST':'GET';
   const response=await worker.fetch(new Request('https://test'+path,{method}),{...base,...bindings} as Env,{} as any);
   expect(response.status).toBe(401);
  }
 });
});
