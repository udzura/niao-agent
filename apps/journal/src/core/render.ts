import MarkdownIt from "markdown-it";
import type { Article, ArticleSummary } from "./articles";
import type { Source } from "./validation";

export interface Site {url: string; title: string; description: string}
export const escape = (text: string) => text.replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]!);
const xml = (text: string) => escape(text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, ""));
const md = new MarkdownIt({html: false, linkify: false, typographer: false});
export const renderMarkdown = (body: string) => md.render(body);
md.disable("image");
const defaultLink = md.renderer.rules.link_open!;
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet("rel", "nofollow noopener noreferrer");
  return defaultLink ? defaultLink(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};
export const articleUrl = (site: Site, article: Pick<Article, "slug">) => `${site.url}/journal/${article.slug}`;
export const publicationDate = (timestamp: string) => new Date(timestamp).toLocaleDateString("ja-JP", {timeZone: "Asia/Tokyo"});
const publicSources = (sources: Source[]) => sources.filter(s => s.public && s.url).map(s => ({title: s.title ?? s.url!, url: s.url!}));
export function layout(site: Site, title: string, description: string, url: string, content: string, extra = "") {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · ${escape(site.title)}</title><meta name="description" content="${escape(description)}">
<link rel="canonical" href="${escape(url)}"><link rel="alternate" type="application/rss+xml" title="${escape(site.title)}" href="${site.url}/feed.xml">
<meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${escape(url)}">${extra}
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.85}body{max-width:46rem;margin:0 auto;padding:1.5rem}a{color:light-dark(#11618a,#89d0f3)}header,footer{padding:1rem 0}header{border-bottom:1px solid #8885}article{overflow-wrap:anywhere}h1{font-size:1.9rem;line-height:1.5}h2{margin-top:2rem}pre{padding:1rem;overflow:auto;background:#8881}blockquote{margin-left:0;padding-left:1rem;border-left:3px solid #8885}.meta,footer{font-size:.9rem;color:light-dark(#555,#bbb)}li{margin:.4rem 0}nav{display:flex;gap:1.5rem}</style></head>
<body><header><a href="${site.url}/journal">${escape(site.title)}</a></header><main>${content}</main><footer><a href="${site.url}/feed.xml">RSS</a> · <a href="${site.url}/llms.txt">AI readers</a> · Written by Niao</footer></body></html>`;
}
export function articleHtml(site: Site, article: Article & {sources: Source[]}) {
  const url = articleUrl(site, article), sources = publicSources(article.sources);
  const structured = JSON.stringify({"@context": "https://schema.org", "@type": "BlogPosting", headline: article.title,
    description: article.description ?? undefined, author: {"@type": "Person", name: "Niao"}, url,
    datePublished: article.publishedAt, dateModified: article.updatedAt, inLanguage: "ja"}).replace(/</g, "\\u003c");
  return layout(site, article.title, article.description ?? "", url,
    `<article><h1>${escape(article.title)}</h1><p class="meta">Niao · 公開: <time datetime="${article.publishedAt}">${publicationDate(article.publishedAt!)}</time>${article.journalDate ? ` · 日記: ${article.journalDate}` : ""}</p>
${md.render(article.bodyMarkdown)}${sources.length ? `<section aria-label="Sources"><h2>参考資料</h2><ul>${sources.map(s => `<li><a rel="nofollow noopener noreferrer" href="${escape(s.url)}">${escape(s.title)}</a></li>`).join("")}</ul></section>` : ""}
<p><a href="${url}.md">Markdownで読む</a></p></article>`,
    `<link rel="alternate" type="text/markdown" href="${url}.md"><meta property="og:type" content="article"><script type="application/ld+json">${structured}</script>`);
}
export function articleMarkdown(site: Site, article: Article & {sources: Source[]}) {
  // JSON strings are valid YAML double-quoted scalars, including embedded newlines.
  const values = {title: article.title, author: "Niao", date: article.journalDate ?? article.publishedAt!.slice(0, 10),
    published_at: article.publishedAt, updated_at: article.updatedAt, description: article.description,
    canonical_url: articleUrl(site, article)};
  const sources = publicSources(article.sources);
  return `---\n${Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n` +
    `sources: ${JSON.stringify(sources)}\n---\n\n# ${article.title.replace(/[\r\n]/g, " ")}\n\n${article.bodyMarkdown}\n`;
}
export function rss(site: Site, articles: ArticleSummary[]) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>${xml(site.title)}</title><description>${xml(site.description)}</description><link>${xml(site.url)}/journal</link><language>ja</language>
<atom:link href="${xml(site.url)}/feed.xml" rel="self" type="application/rss+xml"/>
${articles.map(a => `<item><title>${xml(a.title)}</title><link>${xml(articleUrl(site, a))}</link><guid isPermaLink="false">urn:uuid:${a.id}</guid><pubDate>${new Date(a.publishedAt!).toUTCString()}</pubDate><description>${xml(a.description ?? a.title)}</description></item>`).join("\n")}
</channel></rss>`;
}
export function sitemap(site: Site, articles: {slug: string; updatedAt: string}[], includeIndex = true) {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    (includeIndex ? `<url><loc>${xml(site.url)}/journal</loc></url>` : "") +
    articles.map(a => `<url><loc>${xml(articleUrl(site, a))}</loc><lastmod>${a.updatedAt}</lastmod></url>`).join("") + `</urlset>`;
}
export function sitemapIndex(site: Site, count: number) {
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    Array.from({length: Math.ceil(count / 1000)}, (_, i) => `<sitemap><loc>${xml(site.url)}/sitemap-${i + 1}.xml</loc></sitemap>`).join("") + `</sitemapindex>`;
}
