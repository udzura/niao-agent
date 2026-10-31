export function webArticle(language: "ja" | "en" = "ja", paragraphs = 4): string {
  const paragraph = language === "ja"
    ? "これは日本語の技術記事です。Cloudflare Workersで安全に本文を取得し、読みやすいMarkdownへ変換する仕組みを説明します。段落の構造と重要な情報を残し、余分なメニューを除去します。"
    : "This technical article explains how to extract readable content from web pages in Cloudflare Workers. We preserve useful paragraphs and document structure while excluding navigation and unrelated advertising. This is an invented test fixture, with no external article content.";
  return `<!doctype html><html lang="${language}"><head><title>${language === "ja" ? "日本語の技術メモ" : "Readable technical notes"}</title>
    <meta name="author" content="Niao Test Author"><meta name="description" content="A compact fixture excerpt."></head><body>
    <nav><a href="/home">NAVIGATION_NOISE</a></nav><aside>SIDEBAR_NOISE</aside>
    <main><article><h1>${language === "ja" ? "日本語の技術メモ" : "Readable technical notes"}</h1>
    ${Array.from({length:paragraphs},()=>`<p>${paragraph}</p>`).join("")}
    <h2>Implementation</h2><p>A <a href="../reference?q=1#section">relative reference</a> and <code>ruby_eval</code> are useful.</p>
    <ul><li>First item</li><li>Second item</li></ul><blockquote>Keep the original source link.</blockquote>
    <pre><code class="language-ruby">puts "Hello"\n\n\n  puts "World"\n</code></pre>
    <table><thead><tr><th>Model</th><th>Count</th></tr></thead><tbody><tr><td>Qwen</td><td>2</td></tr></tbody></table>
    <p>Article ending. <a href="javascript:alert(1)">unsafe link text</a></p>
    <script>globalThis.WEB_SCRIPT_EXECUTED = true;</script><style>.advert { color: red; }</style>
    </article></main><footer>FOOTER_NOISE</footer></body></html>`;
}
export function publicDnsFixture(type: string, address?: string) {
  return {Status:0,TC:false,Answer:[{type:type === "AAAA" ? 28 : 1,
    data:address ?? (type === "AAAA" ? "2606:4700:4700::1111" : "1.1.1.1")}]};
}
