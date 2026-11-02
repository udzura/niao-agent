import { SELF, env, applyD1Migrations, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, expect, it } from "vitest";
import { JournalJobs, dueJournalDate, generateJournal, journalRange, journalToolCall, previousTokyoDate, redactJournalContext, tokyoDate } from "../src/journal";

const bindings = env as any, base = "https://test/agents/niao-agent/personal";
const headers = {Authorization: "Bearer test-only-token-000000000000000000000000"};
const article = {title: "調べたD1について", description: "観察の振り返り", bodyMarkdown: "保存された資料からD1のトランザクションについて振り返りました。"};
const stub = () => getAgentByName(bindings.NiaoAgent, "personal");
beforeEach(async () => { await applyD1Migrations(bindings.JOURNAL_TEST_DB, bindings.TEST_JOURNAL_MIGRATIONS); });
afterEach(async () => { await reset(); });

it("uses Tokyo boundaries for dates and the 07:00 schedule, including year rollover", () => {
  expect(tokyoDate(Date.parse("2026-11-01T15:00:00Z"))).toBe("2026-11-02");
  expect(previousTokyoDate(Date.parse("2026-11-01T15:00:00Z"))).toBe("2026-11-01");
  expect(dueJournalDate(Date.parse("2026-11-01T21:59:59Z"))).toBe("2026-10-31");
  expect(dueJournalDate(Date.parse("2026-11-01T22:00:00Z"))).toBe("2026-11-01");
  expect(previousTokyoDate(Date.parse("2026-12-31T22:00:00Z"))).toBe("2026-12-31");
  expect(journalRange("2026-11-01")).toEqual({start: "2026-10-31T15:00:00.000Z", end: "2026-11-01T15:00:00.000Z"});
});

it("uses one structured inference without tools, redacts inputs and validates model output", async () => {
  let calls = 0;
  const ai = {run: async (_model: string, input: any) => {
    calls++; expect(input.tools).toBeUndefined(); expect(input.response_format).toEqual({type: "json_object"});
    expect(input.messages[0].content).toContain("ユーザーの活動報告ではありません");
    expect(input.messages[1].content).toContain("untrusted_reference_data");
    return {response: JSON.stringify(article)};
  }} as unknown as Ai;
  expect(await generateJournal(ai, "2026-11-01", "資料")).toEqual(article); expect(calls).toBe(1);
  for (const response of ["invalid JSON", JSON.stringify({...article, bodyMarkdown: ""}), JSON.stringify({...article, extra: true})])
    await expect(generateJournal({run: async () => ({response})} as any, "2026-11-01", "")).rejects.toThrow();
  const redacted = redactJournalContext("Bearer abcdefghijklmnopqrstuvwxyz12345 user@example.org https://host.internal/a https://example.org/a?token=private password=not-to-be-reproduced");
  for (const secret of ["abcdefghijklmnopqrstuvwxyz", "user@example.org", "host.internal", "?token=private", "not-to-be-reproduced"]) expect(redacted).not.toContain(secret);
  expect(redactJournalContext("a known private value: opaque-token-123456789", ["opaque-token-123456789"])).not.toContain("opaque-token-123456789");
});

it("collects bounded final assistant observations for the target day without user messages or reasoning", async () => {
  await runInDurableObject(await stub(), (a: any) => {
    const date = previousTokyoDate(Date.now()), {start} = journalRange(date);
    a.sql`INSERT INTO niao_turns (requestId,status,sessionId) VALUES ('context','completed','legacy')`;
    a.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt,sessionId) VALUES ('context-user','context','user','PRIVATE_USER_MESSAGE',${start},'legacy')`;
    a.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt,sessionId) VALUES ('context-assistant','context','assistant','D1を調べた',${start},'legacy')`;
    a.sql`INSERT INTO niao_thinking (requestId,generation,text,sessionId) VALUES ('context',0,'PRIVATE_THINKING','legacy')`;
    const context = a.journalJobs().context(date); expect(context).toContain("D1を調べた");
    expect(context).not.toContain("PRIVATE_USER_MESSAGE"); expect(context).not.toContain("PRIVATE_THINKING"); expect(context.length).toBeLessThanOrEqual(12000);
  });
});

it("registers one cron and one maintenance job across restarts, and produces only drafts through real MCP/D1", async () => {
  const result = await runInDurableObject(await stub(), async (a: any) => {
    a.env.JOURNAL_ENABLED = "true";
    a.createJournalArticle = async () => article;
    await a.onStart(); await a.onStart();
    const schedules = await a.listSchedules();
    expect(schedules.filter((s: any) => s.callback === "dailyJournal")).toHaveLength(1);
    expect(schedules.find((s: any) => s.callback === "dailyJournal").cron).toBe("0 22 * * *");
    expect(schedules.filter((s: any) => s.callback === "maintainJournal" && s.type === "interval")).toHaveLength(1);
    await a.dailyJournal(); await a.dailyJournal();
    const run = a.journalJobs().list()[0]; expect(run.status).toBe("draft"); expect(run.attempts).toBe(1); expect(run.notified).toBe(1);
    expect(a.sql`SELECT * FROM niao_messages WHERE requestId LIKE 'journal:%'`).toHaveLength(1);
    const draft = await journalToolCall(a.env, "get_article", {articleId: run.articleId}); expect(draft.status).toBe("draft");
    expect(a.sql`SELECT * FROM cf_agents_mcp_servers`).toEqual([]);
    return run;
  });
  const hidden = await bindings.JOURNAL.fetch(`https://journal.example.org/journal/${result.slug}`);
  expect(hidden.status).toBe(404); await hidden.text();
  await evictDurableObject(await stub(), {webSockets: "close"});
  await runInDurableObject(await stub(), async (a: any) => {
    expect(a.journalJobs().list()[0].articleId).toBe(result.articleId);
    expect((await a.listSchedules()).filter((s: any) => s.callback === "dailyJournal")).toHaveLength(1);
  });
});

it("reuses persisted generated Markdown after a remote commit with lost acknowledgement and eviction", async () => {
  const date = dueJournalDate(Date.now());
  await runInDurableObject(await stub(), async (a: any) => {
    const jobs = new JournalJobs({sql: (s, ...v) => a.sql(s, ...v), generate: async () => article,
      create: async input => { await journalToolCall(a.env, "create_draft", input); throw new Error("lost response"); }, notify: () => {}});
    jobs.initialize(); jobs.enqueue(date); await jobs.maintain();
    expect(jobs.list()[0]).toMatchObject({status: "queued", attempts: 1});
    const saved = a.sql`SELECT payload FROM niao_journal_runs WHERE date=${date}`[0].payload; expect(JSON.parse(saved)).toEqual(article);
  });
  await evictDurableObject(await stub(), {webSockets: "close"});
  await runInDurableObject(await stub(), async (a: any) => {
    a.sql`UPDATE niao_journal_runs SET retryAt=0 WHERE date=${date}`;
    const jobs = new JournalJobs({sql: (s, ...v) => a.sql(s, ...v), generate: async () => { throw Error("must not regenerate"); },
      create: input => journalToolCall(a.env, "create_draft", input), notify: () => {}});
    await jobs.maintain(); expect(jobs.list()[0]).toMatchObject({status: "draft", attempts: 2});
    expect((await journalToolCall(a.env, "list_articles", {})).articles).toHaveLength(1);
  });
});

it("recovers expired leases, fences stale work and caps retries and missed-day catchup", async () => {
  await runInDurableObject(await stub(), async (a: any) => {
    let now = Date.parse("2026-11-01T22:00:00Z");
    const jobs = new JournalJobs({sql: (s, ...v) => a.sql(s, ...v), now: () => now,
      generate: async () => { throw Error("AI unavailable"); }, create: async () => { throw Error(); }, notify: () => {}});
    jobs.initialize(); jobs.enqueue("2026-11-01");
    for (let i = 0; i < 5; i++) { await jobs.maintain(); now += 3600001; }
    expect(jobs.list()[0]).toMatchObject({status: "failed", attempts: 5});
    a.sql`UPDATE niao_journal_runs SET status='generating',lease='abandoned',leaseUntil=0 WHERE date='2026-11-01'`;
    await jobs.maintain(); expect(jobs.list()[0]).toMatchObject({status: "failed", errorCode: "generation_interrupted"});
    now += 20 * 86400000; jobs.catchUp();
    expect(jobs.list().filter(run => run.status === "queued")).toHaveLength(7);
    expect(jobs.enqueue("2026-11-01", true)).toMatchObject({status: "queued", attempts: 0});
  });
});

it("fences a late inference after an expired lease is taken by another attempt", async () => {
  await runInDurableObject(await stub(), async (a: any) => {
    let now = Date.parse("2026-11-01T22:00:00Z"), complete: (value: typeof article) => void = () => {};
    const pending = new Promise<typeof article>(resolve => { complete = resolve; });
    let generated = 0, created = 0;
    const jobs = new JournalJobs({sql: (s, ...v) => a.sql(s, ...v), now: () => now,
      generate: async () => ++generated === 1 ? pending : {...article, title: "new attempt"},
      create: async input => { created++; expect(input.title).toBe("new attempt"); return {articleId: crypto.randomUUID(), slug: "2026-11-01"}; }, notify: () => {}});
    jobs.initialize(); const first = jobs.maintain();
    now += 120001; await jobs.maintain();
    complete(article); await first;
    expect(created).toBe(1); expect(jobs.list()[0]).toMatchObject({status: "draft", attempts: 2});
  });
});

it("offers authenticated manual generation, review and explicit publication through the existing Agent HTTP boundary", async () => {
  expect((await SELF.fetch(`${base}/journal`)).status).toBe(401);
  await runInDurableObject(await stub(), (a: any) => { a.env.JOURNAL_ENABLED = "true"; a.createJournalArticle = async () => article; });
  const request = {method: "POST", headers: {...headers, "Content-Type": "application/json"}, body: JSON.stringify({journalDate: dueJournalDate(Date.now())})};
  expect((await SELF.fetch(`${base}/journal/generate`, request)).status).toBe(202);
  await runInDurableObject(await stub(), async (a: any) => { await a.maintainJournal(); });
  const status = await (await SELF.fetch(`${base}/journal`, {headers})).json<any>();
  const id = status.runs[0].articleId;
  const reviewed = await (await SELF.fetch(`${base}/journal/articles/${id}`, {headers})).json<any>();
  expect(reviewed.bodyMarkdown).toBe(article.bodyMarkdown);
  expect((await SELF.fetch(`${base}/journal/articles/${id}/publish`, {...request, body: JSON.stringify({expectedUpdatedAt: reviewed.updatedAt})})).status).toBe(400);
  const published = await (await SELF.fetch(`${base}/journal/articles/${id}/publish`, {...request,
    body: JSON.stringify({expectedUpdatedAt: reviewed.updatedAt, confirmPublication: true})})).json<any>();
  expect(published.status).toBe("published"); expect((await bindings.JOURNAL.fetch(published.markdownUrl)).headers.get("Content-Type")).toContain("text/markdown");
  const list = await (await SELF.fetch(`${base}/journal/articles`, {headers})).json<any>(); expect(list.articles).toHaveLength(1);
});
