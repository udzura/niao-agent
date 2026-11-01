// Remote Browser Run is an explicit fixture. Production tools-misc and Queue/RPC
// code still execute in workerd; this does not claim real browser conversion QA.
import {WorkerEntrypoint} from "cloudflare:workers";
export default class BrowserFixture extends WorkerEntrypoint {
  async quickAction(action,options) {
    if (action !== "markdown" || typeof options.html !== "string" || "url" in options ||
        options.setJavaScriptEnabled !== false || options.rejectRequestPattern?.[0] !== ".*" ||
        !options.html.includes('<base href="https://articles.example.org/')) throw new Error("Unexpected Browser Run call");
    return Response.json({success:true,result:"# 日本語の技術メモ\n\nBrowser Run test fixture Markdown.",meta:{title:"日本語の技術メモ"}},
      {headers:{"X-Browser-Ms-Used":"25"}});
  }
}
