// Local workerd measurements, not Cloudflare billing CPU metrics. No network or credentials.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {webArticle,publicDnsFixture} from '../../worker/test/fixtures/web.ts';
const require=createRequire(import.meta.url);
const {Miniflare,convertV4MiniflareOptions,Log,LogLevel}=require(require.resolve('miniflare',{paths:[require.resolve('wrangler')]}));
const samples={short:'<html><body><article><p>短い日本語メモです。</p></article></body></html>',
  japanese:webArticle('ja'),english:webArticle('en'),long:webArticle('ja',80)};
const output=process.argv[2];
const expandedLimits=process.env.NIAO_WEB_BENCH_EXPANDED_LIMITS === "1";
if (process.argv[3]) samples.localHtml=await readFile(process.argv[3],'utf8');
const mf=new Miniflare(convertV4MiniflareOptions({inspectorPort:0,log:new Log(LogLevel.NONE),workers:[{
  name:'driver',modules:true,compatibilityDate:'2026-10-27',serviceBindings:{TOOLS_MISC:'niao-tools-misc'},
  script:'export default {async fetch(req,env){return Response.json(await env.TOOLS_MISC.webFetch({url:"https://articles.example.org/"+new URL(req.url).pathname.slice(1)}))}}',
},{name:'niao-tools-misc',modules:true,compatibilityDate:'2026-10-27',compatibilityFlags:['nodejs_compat'],
  scriptPath:fileURLToPath(new URL('../build/index.js',import.meta.url)),
  bindings:expandedLimits?{WEB_FETCH_MAX_DOWNLOAD_BYTES:'131072',WEB_FETCH_MAX_DOM_ELEMENTS:'1500'}:{},
  outboundService:async req=>{
    const url=new URL(req.url);
    if (url.hostname === 'cloudflare-dns.com') return Response.json(publicDnsFixture(url.searchParams.get('type')));
    const html=samples[url.pathname.slice(1)];
    if (url.hostname !== 'articles.example.org' || !html) throw new Error('Unexpected benchmark request');
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
  },
}]}));
let socket;
try {
  const inspector=await mf.getInspectorURL();inspector.protocol='http:';
  const targets=await(await fetch(new URL('/json/list',inspector))).json();
  const target=targets.find(t=>t.id === 'core:user:niao-tools-misc');
  if (!target) throw new Error('Tools Worker inspector missing');
  socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);const entry=pending.get(message.id);
    if (entry) {pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error(message.error.message)):entry.resolve(message.result);}
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++next;const timer=setTimeout(()=>reject(new Error('Inspector timeout')),10000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
  await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:100});
  const report={runtime:'local workerd',expandedLimits,samplingIntervalUs:100,method:'V8 sampled active CPU per RPC; excludes idle/root/program samples; not a billing metric',cases:[]};
  for (const [name,html] of Object.entries(samples)) {
    const measurements=[];
    for (let run=0;run<11;run++) {
      await send('Profiler.start');
      const start=performance.now();
      const result=await(await mf.dispatchFetch('https://benchmark.invalid/'+name)).json();
      const wallMs=performance.now()-start;
      const {profile}=await send('Profiler.stop');
      if (!result.ok) throw new Error(`Benchmark ${name}: ${result.error}`);
      const nodes=new Map(profile.nodes.map(node=>[node.id,node]));
      const parents=new Map(profile.nodes.flatMap(node=>(node.children??[]).map(child=>[child,node.id])));
      const extractionNode=id=>{
        while (id) {if (['extractReadableContent','normalizeWebContent'].includes(nodes.get(id).callFrame.functionName)) return true;id=parents.get(id);}
        return false;
      };
      const extractionUs=profile.samples.reduce((sum,id,i)=>sum+(extractionNode(id)?(profile.timeDeltas[i]??0):0),0);
      const activeUs=profile.samples.reduce((sum,id,i)=>['(idle)','(root)','(program)'].includes(nodes.get(id).callFrame.functionName)?sum:sum+(profile.timeDeltas[i]??0),0);
      measurements.push({run,sampledCpuMs:activeUs/1000,sampledExtractionCpuMs:extractionUs/1000,wallMs,truncated:result.truncated});
      if (output) {await mkdir(output,{recursive:true});await writeFile(`${output}/${name}-${run}.cpuprofile`,JSON.stringify(profile));}
    }
    const warm=measurements.slice(1).map(m=>m.sampledCpuMs).sort((a,b)=>a-b);
    report.cases.push({name,htmlBytes:Buffer.byteLength(html),firstSampledCpuMs:measurements[0].sampledCpuMs,
      warmMedianCpuMs:warm[Math.floor(warm.length/2)],warmMaxCpuMs:Math.max(...warm),measurements});
  }
  console.log(JSON.stringify(report,null,2));
  if (output) await writeFile(`${output}/summary.json`,JSON.stringify(report,null,2)+'\n');
} finally {socket?.close();await mf.dispose();}
