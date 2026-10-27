import { SELF, env, runInDurableObject, reset, evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it } from "vitest";
import { NiaoAgent } from "../src/niao-agent";
import { ChatError } from "../src/protocol";

const headers = {Authorization: "Bearer test-only-token-000000000000000000000000"};
const base = "https://test/agents/niao-agent/personal";
const sockets: WebSocket[] = [];
afterEach(async () => { for (const ws of sockets.splice(0)) ws.close(); await reset(); });
async function stub() { return getAgentByName((env as any).NiaoAgent, "personal"); }
async function model(mode: "ok" | "fail" | "slow" = "ok") {
  await runInDurableObject(await stub(), (agent: NiaoAgent) => {
    (agent as any).createModel = () => ({async *stream() {
      yield {text: "こん"};
      if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 80));
      if (mode === "fail") throw new ChatError("ai_rate_limited");
      yield {text: "にちは"};
      yield {usage: {total_tokens: 8, neurons: 2.5}};
      yield {usage: {total_tokens: 8, neurons: 2.5}};
    }});
  });
}
async function connect() {
  const response = await SELF.fetch(base, {headers: {...headers, Upgrade: "websocket"}});
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const events: any[] = [];
  ws.addEventListener("message", event => { events.push(JSON.parse(event.data as string)); });
  ws.accept(); sockets.push(ws);
  const until = async (predicate: (event: any) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Expected protocol event not received");
  };
  await until(e => e.type === "ready");
  return {ws, events, until};
}
const send = (ws: WebSocket, requestId: string, content = "hello") => ws.send(JSON.stringify({v: 1, type: "send", requestId, content}));
async function history(after = 0) {
  const response = await SELF.fetch(`${base}/history?after=${after}`, {headers});
  expect(response.status).toBe(200);
  return response.json<any>();
}

describe("authenticated Worker boundary", () => {
  it("rejects unauthenticated HTTP and upgrades before allocating an agent", async () => {
    for (const path of ["/health", "/agents/niao-agent/personal/usage", "/agents/niao-agent/personal/history", "/agents/niao-agent/personal"]) {
      expect((await SELF.fetch(`https://test${path}`)).status).toBe(401);
      expect((await SELF.fetch(`https://test${path}`, {headers: {Upgrade: "websocket"}})).status).toBe(401);
    }
    expect((await SELF.fetch("https://test/health", {headers})).status).toBe(200);
    expect((await SELF.fetch("https://test/health?token=anything")).status).toBe(401);
    expect((await SELF.fetch("https://test/agents/niao-agent/other", {headers})).status).toBe(404);
    expect((await SELF.fetch(base, {method: "POST", headers})).status).toBe(405);
  });
});
describe("persistent chat using the real Agent and SQLite runtime", () => {
  it("streams, commits, deduplicates retry, and survives actual eviction", async () => {
    await model();
    const client = await connect();
    const id = crypto.randomUUID();
    send(client.ws, id);
    const completed = await client.until(e => e.type === "committed");
    expect(completed.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(client.events.filter(e => e.type === "partial").map(e => e.text)).toEqual(["こん", "こんにちは"]);
    send(client.ws, id);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect((await history()).messages).toHaveLength(2);
    client.ws.close();
    await evictDurableObject(await stub(), {webSockets: "close"});
    const recovered = await history();
    expect(recovered.messages).toEqual(completed.messages);
    const next = await connect();
    send(next.ws, id);
    expect((await next.until(e => e.type === "committed")).messages).toEqual(completed.messages);
    expect((await history(completed.messages[0].seq)).messages).toEqual([completed.messages[1]]);
  });
  it("keeps partial output transient and retries failed turns without duplicating the user", async () => {
    await model("fail");
    const client = await connect();
    const id = crypto.randomUUID(); send(client.ws, id);
    expect((await client.until(e => e.type === "error")).code).toBe("ai_rate_limited");
    const failed = await history();
    expect(failed.messages).toHaveLength(1);
    expect(failed.turns[0].status).toBe("failed");
    expect(failed.active).toBeNull();
    await model(); send(client.ws, id);
    await client.until(e => e.type === "committed");
    expect((await history()).messages).toHaveLength(2);
  });
  it("does not run a second generation for duplicate in-flight sends or conflict", async () => {
    await model("slow");
    const a = await connect(); const b = await connect();
    const id = crypto.randomUUID(); send(a.ws, id);
    await a.until(e => e.type === "partial");
    send(b.ws, id); send(b.ws, id, "different");
    const otherID = crypto.randomUUID(); send(b.ws, otherID);
    expect((await b.until(e => e.type === "error" && e.requestId === id)).code).toBe("id_conflict");
    expect((await b.until(e => e.type === "error" && e.requestId === otherID)).code).toBe("busy");
    await a.until(e => e.type === "committed");
    expect((await history()).messages).toHaveLength(2);
  });
  it("reports a persisted running turn as interrupted after eviction", async () => {
    const id = crypto.randomUUID();
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      agent.sql`INSERT INTO niao_turns (requestId,status) VALUES (${id},'running')`;
      agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt) VALUES (${id},${id},'user','hello','2026-10-27T00:00:00Z')`;
    });
    await evictDurableObject(await stub());
    const page = await history();
    expect(page.messages).toHaveLength(1);
    expect(page.turns).toEqual([{requestId: id, status: "failed", errorCode: "interrupted"}]);
    await model(); const client = await connect(); send(client.ws, id);
    await client.until(e => e.type === "committed");
    expect((await history()).messages).toHaveLength(2);
  });
  it("keeps the original prompt when retrying an old failure after many later turns", async () => {
    const id = crypto.randomUUID();
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      agent.sql`INSERT INTO niao_turns (requestId,status) VALUES (${id},'failed')`;
      agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt) VALUES (${id},${id},'user','original prompt','2026-10-27T00:00:00Z')`;
      for (let i = 0; i < 30; i++) {
        const later = `later-${i}`;
        agent.sql`INSERT INTO niao_turns (requestId,status) VALUES (${later},'completed')`;
        agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt) VALUES (${later},${later},'user','later prompt','2026-10-27T01:00:00Z')`;
      }
      (agent as any).createModel = () => ({async *stream(messages: any[]) {
        if (messages.at(-1)?.content !== "original prompt" || messages.length !== 2) throw new Error("Incorrect historical context");
        yield {text: "original answer"};
      }});
    });
    const client = await connect(); send(client.ws, id, "original prompt");
    expect((await client.until(e => e.type === "committed")).messages[1].content).toBe("original answer");
  });
  it("persists observed usage once per inference, counts unknown attempts and survives eviction", async () => {
    const usage = async () => (await SELF.fetch(`${base}/usage`, {headers})).json<any>();
    await model(); const client = await connect();
    const id = crypto.randomUUID(); send(client.ws, id);
    await client.until(e => e.type === "committed");
    send(client.ws, id); // A retry of the completed submission must not count again.
    await new Promise(resolve => setTimeout(resolve, 30));
    const first = await usage();
    expect(first.account.status).toBe("not_configured");
    expect(first.account.neurons).toBeNull();
    expect(first.local).toMatchObject({neurons: 2.5, attempts: 1, unmeasuredAttempts: 0});
    await model("fail"); const failedID = crypto.randomUUID(); send(client.ws, failedID);
    await client.until(e => e.type === "error" && e.requestId === failedID);
    expect((await usage()).local).toMatchObject({neurons: 2.5, attempts: 2, unmeasuredAttempts: 1});
    await model(); send(client.ws, failedID);
    await client.until(e => e.type === "committed" && e.requestId === failedID);
    client.ws.close(); await evictDurableObject(await stub(), {webSockets: "close"});
    const recovered = await usage();
    expect(recovered.local).toMatchObject({neurons: 5, attempts: 3, unmeasuredAttempts: 1, trackingSince: first.local.trackingSince});
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      agent.sql`INSERT INTO niao_usage_attempts VALUES ('old', '2000-01-01T12:00:00.000Z', 999)`;
    });
    expect((await usage()).local.neurons).toBe(5);
    const response = await SELF.fetch(`${base}/usage`, {headers});
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("validates input and cursor, and pages history without gaps", async () => {
    const client = await connect();
    for (const content of ["", " ", "x".repeat(8001)]) send(client.ws, crypto.randomUUID(), content);
    await client.until(e => e.type === "error");
    expect((await history()).messages).toHaveLength(0);
    expect((await SELF.fetch(`${base}/history?after=-1`, {headers})).status).toBe(400);
    await runInDurableObject(await stub(), (agent: NiaoAgent) => {
      for (let i = 0; i < 105; i++) agent.sql`INSERT INTO niao_messages (id,requestId,role,content,createdAt) VALUES (${String(i)},${String(i)},'user','seed','2026-10-27T00:00:00Z')`;
    });
    const first = await history(); const last = await history(first.cursor);
    expect(first.messages).toHaveLength(100); expect(first.hasMore).toBe(true);
    expect(last.messages).toHaveLength(5); expect(last.hasMore).toBe(false);
    expect(new Set([...first.messages, ...last.messages].map(m => m.seq)).size).toBe(105);
  });
});
