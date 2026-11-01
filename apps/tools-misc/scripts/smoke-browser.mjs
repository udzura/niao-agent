// Explicit live probe: local workerd + the real remote Browser Run binding.
// Source HTTP is a synthetic fixture; remote rendering is not mocked.
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {getPlatformProxy} from "wrangler";
import {Miniflare} from "miniflare";
import {build} from "esbuild";
if (!process.argv.includes("--real")) {
  console.error("Usage: node apps/tools-misc/scripts/smoke-browser.mjs --real (uses Browser Run quota)");
  process.exit(1);
}
let proxy,local;
const deadline=setTimeout(()=>{console.error("Browser Run probe timed out");process.exit(1);},55000);
try {
  const modulePath=fileURLToPath(new URL("../src/web-fetch-async.ts",import.meta.url));
  const html='<html><head><title>Niao Browser Probe</title></head><body><article><h1>Niao Browser Probe</h1>'+ '<p>日本語の変換確認。Cloudflare WorkersのDOM処理をBrowser Runへ移すための架空記事です。</p>'.repeat(300) + '<a href="../reference#section">relative reference</a></article><script>document.body.innerHTML="SCRIPT_RAN"</script><img src="https://articles.example.org/image.png" onerror="document.body.innerHTML=String.fromCharCode(69,86,69,78,84)"><iframe src="http://127.0.0.1/"></iframe><meta http-equiv="refresh" content="0;url=http://127.0.0.1/"></body></html>';
  assert(Buffer.byteLength(html)>32768);
  proxy=await getPlatformProxy({configPath:fileURLToPath(new URL("../wrangler.jsonc",import.meta.url)),persist:false,remoteBindings:true,envFiles:[]});
  const compiled=await build({bundle:true,write:false,format:"esm",platform:"browser",stdin:{contents:`
    import {WebFetchAsyncService} from ${JSON.stringify(modulePath)};
    const html=${JSON.stringify(html)};
    export default {async fetch(_request,env) {
      // Bridge only the remote call; all production preparation, result handling
      // and limits run in workerd, including native HTMLRewriter.
      const BROWSER={quickAction:async(_action,options)=>env.BROWSER_BRIDGE.fetch('https://browser-probe.invalid/',{method:'POST',body:JSON.stringify(options)})};
      return Response.json(await new WebFetchAsyncService({BROWSER,WEB_FETCH_ASYNC_MAX_CONTENT_CHARS:'32000',WEB_FETCH_ASYNC_MAX_RESULT_BYTES:'65536'},async(input)=>{
        const url=new URL(String(input));
        if(url.hostname==='cloudflare-dns.com')return Response.json({Status:0,TC:false,Answer:[{type:url.searchParams.get('type')==='AAAA'?28:1,data:url.searchParams.get('type')==='AAAA'?'2606:4700:4700::1111':'1.1.1.1'}]});
        if(url.href!=='https://articles.example.org/posts/probe')throw Error('Unexpected external fetch');
        return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
      }).get({url:'https://articles.example.org/posts/probe'}));
    }};
  `,resolveDir:process.cwd()}});
  local=new Miniflare({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:"2026-10-27",
    serviceBindings:{BROWSER_BRIDGE:async request=>{
      const response=await proxy.env.BROWSER.quickAction("markdown",await request.json());
      return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
    }},
  });
  const result=await (await local.dispatchFetch('https://browser-probe.invalid/')).json();
  assert.equal(result.ok,true,result.error);
  assert.equal(result.contentType,"text/markdown");
  assert.equal(result.finalUrl,"https://articles.example.org/posts/probe");
  assert(result.content.includes("日本語の変換確認"));
  assert(result.content.includes("https://articles.example.org/reference#section"));
  assert(!result.content.includes("SCRIPT"));
  assert(!result.content.includes("EVENT"));
  console.log(JSON.stringify({ok:true,sourceBytes:Buffer.byteLength(html),title:result.title,contentChars:result.content.length,truncated:result.truncated,japanese:true,relativeLinks:true,scriptSuppressed:true}));
} finally {
  clearTimeout(deadline);
  await local?.dispose();
  await proxy?.dispose();
}
