import { rubyExecutor } from "./ruby/tool";
import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import type { Env } from "./index";
import { boundedContext, DEFAULT_MODEL, MODELS, isModelID, supportsThinking, type ModelID, WorkersAIModel, type ChatModel, type ModelMessage } from "./model";
import { ChatError, errorCode, parseSubmission, type Message, type Turn, type ThinkingSegment } from "./protocol";
import { ClefThinkingJudge, isThinkingMode, thinkingPolicy, JUDGE_MODEL, type ThinkingMode, type ThinkingPolicy, type ThinkingJudge } from "./thinking-policy";

import { UsageAnalytics, utcDay, validNeurons } from "./usage";
import { withPastLogsTools, type AdditionalTool } from "./past-logs";

type Active = { requestId: string; text: string; thinking?: ThinkingSegment[] };
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({event, ...fields}));

export class NiaoAgent extends Agent<Env> {
  static options = { sendIdentityOnConnect: false };
  observability = undefined; // SDK event payloads are not part of our safe logging contract.
  private analytics = new UsageAnalytics(this.env);
  private active: Active | null = null;
  private bootId = crypto.randomUUID();

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS niao_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, requestId TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL, createdAt TEXT NOT NULL,
      UNIQUE(requestId, role)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS niao_thinking (
      requestId TEXT NOT NULL, generation INTEGER NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY(requestId, generation)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS niao_turns (
      requestId TEXT PRIMARY KEY, status TEXT NOT NULL, errorCode TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS niao_usage_attempts (
      id TEXT PRIMARY KEY, startedAt TEXT NOT NULL, neurons REAL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS niao_judge_attempts (
      id TEXT PRIMARY KEY, durationMs REAL, score REAL, reason TEXT,
      usageSource TEXT, inputTokens INTEGER, neuronsPerMillion REAL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS niao_usage_day ON niao_usage_attempts(startedAt)`;
    this.sql`CREATE TABLE IF NOT EXISTS niao_usage_meta (id INTEGER PRIMARY KEY, trackingSince TEXT NOT NULL)`;
    this.sql`INSERT OR IGNORE INTO niao_usage_meta VALUES (1, ${new Date().toISOString()})`;
    this.sql`CREATE TABLE IF NOT EXISTS niao_settings (id INTEGER PRIMARY KEY, modelId TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
      thinkingEnabled INTEGER NOT NULL DEFAULT 0 CHECK (thinkingEnabled IN (0,1)))`;
    if (!this.sql<{name:string}>`PRAGMA table_info(niao_settings)`.some(column => column.name === "thinkingEnabled")) {
      this.sql`ALTER TABLE niao_settings ADD COLUMN thinkingEnabled INTEGER NOT NULL DEFAULT 0 CHECK (thinkingEnabled IN (0,1))`;
    }
    this.sql`INSERT OR IGNORE INTO niao_settings (id, modelId, epoch) VALUES (1, ${DEFAULT_MODEL}, 0)`;
    const columns = this.sql<{name:string}>`PRAGMA table_info(niao_settings)`;
    if (!columns.some(column => column.name === "thinkingMode")) {
      this.ctx.storage.transactionSync(() => {
        this.sql`ALTER TABLE niao_settings ADD COLUMN thinkingMode TEXT NOT NULL DEFAULT 'off' CHECK (thinkingMode IN ('auto','on','off'))`;
        this.sql`UPDATE niao_settings SET thinkingMode = CASE WHEN thinkingEnabled = 1 THEN 'on' ELSE 'off' END`;
      });
    }
    if (!columns.some(column => column.name === "thinkingPolicy")) {
      this.sql`ALTER TABLE niao_settings ADD COLUMN thinkingPolicy TEXT NOT NULL DEFAULT '{}'`;
    }
    // A fresh isolate cannot resume an in-flight provider stream. Keep the user message;
    // require an explicit retry instead of silently charging for another generation.
    this.sql`UPDATE niao_turns SET status = 'failed', errorCode = 'interrupted' WHERE status = 'running'`;
    log("agent.started");
  }

  shouldConnectionBeReadonly() { return true; }
  shouldSendProtocolMessages() { return false; }
  onConnect(connection: Connection, _context: ConnectionContext) {
    this.send(connection, {type: "ready", bootId: this.bootId, active: this.active});
    log("connection.open", {connectionId: connection.id});
  }
  onClose(connection: Connection, code: number) { log("connection.close", {connectionId: connection.id, code}); }
  onError(_connectionOrError: unknown, _error?: unknown) { log("agent.error", {code: "internal_error"}); }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/settings")) {
      if (request.method === "GET") return this.json(this.settingsResponse());
      if (request.method !== "PUT") return this.json({code: "method_not_allowed"}, 405);
      let body: {modelId?: unknown; thinkingEnabled?: unknown; thinkingMode?: unknown; thinkingPolicy?: unknown};
      try {
        if (!request.headers.get("Content-Type")?.startsWith("application/json")) return this.json({code: "invalid_settings"}, 400);
        const text = await request.text();
        if (text.length > 1024) return this.json({code: "invalid_settings"}, 400);
        body = JSON.parse(text);
      } catch { return this.json({code: "invalid_settings"}, 400); }
      if (!body || !isModelID(body.modelId)) return this.json({code: "unsupported_model"}, 400);
      if (body.thinkingEnabled !== undefined && typeof body.thinkingEnabled !== "boolean") return this.json({code: "invalid_settings"}, 400);
      if (body.thinkingMode !== undefined && (!isThinkingMode(body.thinkingMode) || body.thinkingEnabled !== undefined)) return this.json({code:"invalid_settings"},400);
      const current = this.settings();
      const mode = (body.thinkingMode as ThinkingMode | undefined) ??
        (body.thinkingEnabled === undefined ? current.thinkingMode : body.thinkingEnabled ? "on" : "off");
      let policy: ThinkingPolicy;
      try { policy = body.thinkingPolicy === undefined ? current.thinkingPolicy : thinkingPolicy(body.thinkingPolicy,current.thinkingPolicy); }
      catch { return this.json({code:"invalid_settings"},400); }
      // Keep the legacy boolean for rollback/old clients; model-only updates preserve auto.
      this.sql`UPDATE niao_settings SET modelId = ${body.modelId}, thinkingEnabled = ${mode === "on" ? 1 : 0},
        thinkingMode = ${mode}, thinkingPolicy = ${JSON.stringify(policy)} WHERE id = 1`;
      this.publish({type: "settings_updated", settings: this.settingsResponse()});
      return this.json(this.settingsResponse());
    }
    if (url.pathname.endsWith("/history") && request.method === "DELETE") {
      const match = request.headers.get("If-Match");
      if (!match || !/^"[0-9]+"$/.test(match)) return this.json({code: "precondition_required"}, 428);
      if (Number(match.slice(1, -1)) !== this.settings().epoch) return this.json({code: "history_changed"}, 409);
      if (this.active) return this.json({code: "busy"}, 409);
      this.ctx.storage.transactionSync(() => {
        this.sql`DELETE FROM niao_messages`;
        this.sql`DELETE FROM niao_turns`;
        this.sql`DELETE FROM niao_thinking`;
        this.sql`UPDATE niao_settings SET epoch = epoch + 1 WHERE id = 1`;
      });
      this.publish({type: "history_cleared"});
      return this.json({v: 1, epoch: this.settings().epoch});
    }
    if (request.method !== "GET") return this.json({code: "method_not_allowed"}, 405);
    if (url.pathname.endsWith("/usage")) return this.usageResponse();
    if (!url.pathname.endsWith("/history")) return new Response("WebSocket upgrade required", {status: 426});
    let after = Number(url.searchParams.get("after") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0) return new Response("Invalid cursor", {status: 400});
    const settings = this.settings();
    if (Number(url.searchParams.get("epoch") ?? "0") !== settings.epoch) after = 0;
    const rows = this.sql<Message>`SELECT * FROM niao_messages WHERE seq > ${after} ORDER BY seq LIMIT 101`;
    const messages = this.withThinking(rows.slice(0, 100));
    return Response.json({v: 1, epoch: settings.epoch, settings: this.settingsResponse(), messages, cursor: messages.at(-1)?.seq ?? after, hasMore: rows.length > 100,
      turns: this.sql<Turn>`SELECT * FROM niao_turns WHERE status != 'completed'`, active: this.active,
    }, {headers: {"Cache-Control": "no-store"}});
  }

  private async usageResponse(): Promise<Response> {
    // Retry the date selection if UTC midnight passes during the remote request.
    let now = new Date();
    let account = await this.analytics.today(now);
    if (utcDay(new Date()).dayStart !== utcDay(now).dayStart) {
      now = new Date();
      account = await this.analytics.today(now);
    }
    const period = utcDay(now);
    const recorded = this.sql<{neurons: number; attempts: number; unmeasuredAttempts: number}>`
      SELECT COALESCE(SUM(neurons), 0) AS neurons, COUNT(*) AS attempts,
        COUNT(*) - COUNT(neurons) AS unmeasuredAttempts FROM niao_usage_attempts
      WHERE startedAt >= ${period.dayStart} AND startedAt < ${period.dayEnd}`[0];
    const {trackingSince} = this.sql<{trackingSince: string}>`SELECT trackingSince FROM niao_usage_meta WHERE id = 1`[0];
    const judge = this.sql<{neurons:number;attempts:number;unmeasuredAttempts:number;calculatedAttempts:number;totalDurationMs:number;timedAttempts:number}>`
      SELECT COALESCE(SUM(a.neurons),0) AS neurons, COUNT(*) AS attempts,
        COUNT(*) - COUNT(a.neurons) AS unmeasuredAttempts,
        COALESCE(SUM(CASE WHEN j.usageSource = 'rate' THEN 1 ELSE 0 END),0) AS calculatedAttempts,
        COALESCE(SUM(j.durationMs),0) AS totalDurationMs, COUNT(j.durationMs) AS timedAttempts
      FROM niao_judge_attempts j JOIN niao_usage_attempts a ON a.id = j.id
      WHERE a.startedAt >= ${period.dayStart} AND a.startedAt < ${period.dayEnd}`[0];
    return Response.json({v: 1, ...period, asOf: new Date().toISOString(), account,
      local: {...recorded, trackingSince, judge}}, {headers: {"Cache-Control": "no-store"}});
  }

  private withThinking(messages: Message[]): Message[] {
    return messages.map(message => {
      if (message.role !== "assistant") return message;
      const rows = this.sql<{generation:number;text:string}>`SELECT generation, text FROM niao_thinking WHERE requestId = ${message.requestId} ORDER BY generation`;
      return rows.length ? {...message,thinking:rows.map(row => ({...row,active:false}))} : message;
    });
  }
  private settings(): {modelId: ModelID; epoch: number; thinkingMode:ThinkingMode; thinkingPolicy:ThinkingPolicy} {
    const row = this.sql<{modelId:ModelID;epoch:number;thinkingMode:ThinkingMode;thinkingPolicy:string}>`SELECT modelId, epoch, thinkingMode, thinkingPolicy FROM niao_settings WHERE id = 1`[0];
    return {...row,thinkingPolicy:thinkingPolicy(JSON.parse(row.thinkingPolicy))};
  }
  private settingsResponse() { const settings = this.settings(); return {v:1,...settings,thinkingEnabled:settings.thinkingMode === "on",models:MODELS}; }
  private json(data: object, status = 200) { return Response.json(data, {status, headers: {"Cache-Control": "no-store"}}); }
  protected createModel(modelId: ModelID, thinkingEnabled: boolean, tools: AdditionalTool[] = []): ChatModel {
    return new WorkersAIModel(this.env.AI, modelId, rubyExecutor(this.env.RUBY_RUNNER), thinkingEnabled, tools);
  }
  protected createThinkingJudge(): ThinkingJudge { return new ClefThinkingJudge(this.env.AI); }

  async onMessage(connection: Connection, raw: WSMessage) {
    let requestId: string | undefined;
    let claimed = false;
    try {
      const input = parseSubmission(raw);
      requestId = input.requestId;
      if ((input.epoch ?? 0) !== this.settings().epoch) throw new ChatError("history_changed");
      const existing = this.sql<Message>`SELECT * FROM niao_messages WHERE requestId = ${requestId} AND role = 'user'`[0];
      if (existing && existing.content !== input.content) throw new ChatError("id_conflict");
      const turn = this.sql<Turn>`SELECT * FROM niao_turns WHERE requestId = ${requestId}`[0];
      if (turn?.status === "completed") {
        this.send(connection, {type: "committed", requestId, messages: this.withThinking(this.sql<Message>`SELECT * FROM niao_messages WHERE requestId = ${requestId} ORDER BY seq`)});
        return;
      }
      if (this.active) {
        if (this.active.requestId === requestId) {
          this.send(connection, {type: "accepted", requestId, message: existing});
          this.send(connection, {type: "partial", ...this.active});
          return;
        }
        throw new ChatError("busy");
      }
      // No await between checking and claiming the single active turn.
      this.active = {requestId, text: ""};
      claimed = true;
      this.ctx.storage.transactionSync(() => {
        this.sql`INSERT OR IGNORE INTO niao_messages (id, requestId, role, content, createdAt)
          VALUES (${input.requestId}, ${input.requestId}, 'user', ${input.content}, ${new Date().toISOString()})`;
        this.sql`INSERT INTO niao_turns (requestId, status) VALUES (${input.requestId}, 'running')
          ON CONFLICT(requestId) DO UPDATE SET status = 'running', errorCode = NULL`;
      });
      const user = this.sql<Message>`SELECT * FROM niao_messages WHERE id = ${requestId}`[0];
      this.publish({type: "accepted", requestId, message: user});
      await this.generate(requestId);
    } catch (error) {
      this.send(connection, {type: "error", requestId, code: error instanceof ChatError ? error.code : "internal_error"});
      log("submission.error", {requestId, code: error instanceof ChatError ? error.code : "internal_error"});
      if (claimed && this.active?.requestId === requestId) this.active = null;
    }
  }

  private async generate(requestId: string) {
    const {modelId, thinkingMode, thinkingPolicy: policy} = this.settings(); // Snapshot policy for the whole turn.
    const start = Date.now();
    const startAttempt = () => {
      const id = crypto.randomUUID();
      this.sql`INSERT INTO niao_usage_attempts (id, startedAt) VALUES (${id}, ${new Date().toISOString()})`;
      return id;
    };
    let attemptId: string;
    log("llm.start", {requestId, model:modelId, thinkingMode});
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A hard deadline covers binding setup as well as stalled reads. The race prevents
    // a provider ignoring cancellation from leaving the agent permanently busy.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ChatError("ai_timeout")); }, 90_000);
    });
    try {
      const user = this.sql<Message>`SELECT * FROM niao_messages WHERE requestId = ${requestId} AND role = 'user'`[0];
      const recent = this.sql<ModelMessage>`SELECT m.role, m.content FROM niao_messages m
        JOIN niao_turns t ON t.requestId = m.requestId
        WHERE t.status = 'completed' AND m.seq < ${user.seq}
        ORDER BY m.seq DESC LIMIT 23`.reverse();
      // Retrying an old failed turn must still include that user message, even
      // when many newer completed messages exist. Reuse its original context.
      recent.push({role: "user", content: user.content});
      let text = "";
      const thinking: ThinkingSegment[] = [];
      let thinkingLength = 0;
      const publishPartial = () => {
        this.active = {requestId,text,...(thinking.length ? {thinking} : {})};
        this.publish({type:"partial",...this.active});
      };
      let usage: Record<string, number> = {};
      const consume = async (tools: AdditionalTool[]) => {
        let thinkingEnabled = thinkingMode === "on";
        if (thinkingMode === "auto" && supportsThinking(modelId)) {
          const id = this.ctx.storage.transactionSync(() => {
            const id = startAttempt();
            this.sql`INSERT INTO niao_judge_attempts (id) VALUES (${id})`;
            return id;
          });
          const decision = await this.createThinkingJudge().decide(recent,policy,controller.signal);
          const receipt = decision.usage;
          this.ctx.storage.transactionSync(() => {
            this.sql`UPDATE niao_usage_attempts SET neurons = ${receipt.neurons} WHERE id = ${id}`;
            this.sql`UPDATE niao_judge_attempts SET durationMs = ${decision.durationMs}, score = ${decision.score}, reason = ${decision.reason},
              usageSource = ${receipt.source}, inputTokens = ${receipt.inputTokens}, neuronsPerMillion = ${receipt.neuronsPerMillion} WHERE id = ${id}`;
          });
          log("thinking.decision", {requestId,model:JUDGE_MODEL,enabled:decision.enabled,score:decision.score,reason:decision.reason,
            durationMs:decision.durationMs,neurons:receipt.neurons,usageSource:receipt.source});
          thinkingEnabled = decision.enabled;
        }
        controller.signal.throwIfAborted();
        attemptId = startAttempt();
        for await (const part of this.createModel(modelId, thinkingEnabled, tools).stream(boundedContext(recent), controller.signal)) {
          controller.signal.throwIfAborted();
          if ("text" in part) {
            text += part.text;
            if (text.length > 64_000) throw new ChatError("response_too_large");
            publishPartial();
          } else if ("thinking" in part) {
            const {generation,text:delta,active} = part.thinking;
            if (!Number.isInteger(generation) || generation < 0 || generation > 3) throw new ChatError("invalid_ai_response");
            thinkingLength += delta.length;
            if (thinkingLength > 32_000) throw new ChatError("response_too_large");
            let segment = thinking.find(item => item.generation === generation);
            if (!segment) { segment = {generation,text:"",active}; thinking.push(segment); }
            segment.text += delta; segment.active = active;
            publishPartial();
          } else if ("inferenceStarted" in part) {
            attemptId = startAttempt();
            usage = {};
          } else if ("toolStatus" in part) {
            const name = part.name ?? "ruby_eval";
            this.publish({type:"tool_status",requestId,name,status:part.toolStatus});
            log("tool.execution", {requestId,name,status:part.toolStatus});
          } else if ("usage" in part) {
            usage = {...usage, ...part.usage};
            if (validNeurons(part.usage.neurons)) {
              // Each provider usage frame is a cumulative total, not a delta.
              // Save before final message commit, including failed/empty responses.
              this.sql`UPDATE niao_usage_attempts SET neurons = ${part.usage.neurons} WHERE id = ${attemptId}`;
            }
          }
        }
      };
      await Promise.race([withPastLogsTools(this.mcp, this.env, controller.signal, consume), timeout]);
      if (!text.trim()) throw new ChatError("empty_ai_response");
      this.ctx.storage.transactionSync(() => {
        this.sql`INSERT INTO niao_messages (id, requestId, role, content, createdAt)
          VALUES (${`assistant:${requestId}`}, ${requestId}, 'assistant', ${text}, ${new Date().toISOString()})`;
        for (const segment of thinking.filter(item => item.text.trim())) {
          this.sql`INSERT INTO niao_thinking (requestId, generation, text) VALUES (${requestId}, ${segment.generation}, ${segment.text})`;
        }
        this.sql`UPDATE niao_turns SET status = 'completed', errorCode = NULL WHERE requestId = ${requestId}`;
      });
      this.publish({type: "committed", requestId, messages: this.withThinking(this.sql<Message>`SELECT * FROM niao_messages WHERE requestId = ${requestId} ORDER BY seq`)});
      log("llm.complete", {requestId, model: modelId, durationMs: Date.now() - start, usage});
    } catch (error) {
      const code = errorCode(error);
      this.sql`UPDATE niao_turns SET status = 'failed', errorCode = ${code} WHERE requestId = ${requestId}`;
      this.publish({type: "error", requestId, code});
      log("llm.error", {requestId, model: modelId, durationMs: Date.now() - start, code});
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      this.active = null;
    }
  }

  private send(connection: Connection, event: object) {
    try { connection.send(JSON.stringify({v: 1, epoch: this.settings().epoch, ...event})); } catch { /* Reconnect uses HTTP history. */ }
  }
  private publish(event: object) { for (const connection of this.getConnections()) this.send(connection, event); }
}
