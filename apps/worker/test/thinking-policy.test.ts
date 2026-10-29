import {describe,it,expect} from "vitest";
import {ClefThinkingJudge,DEFAULT_THINKING_POLICY,JUDGE_MODEL,judgeContext,judgeUsage,thinkingPolicy} from "../src/thinking-policy";
const response = (score:unknown,usage:unknown={input_tokens:1000,output_tokens:0}) => ({answers:{needs_thinking:{type:"noul",noul:score}},usage});
const ai = (run: (...args:any[]) => unknown) => ({run} as unknown as Ai);
const messages = [{role:"user" as const,content:"この設計を比較して"}];
const signal = () => new AbortController().signal;
describe("Clef thinking policy",()=>{
  it("validates adjustable thresholds, ambiguity policy and timeout without altering defaults",()=>{
    expect(thinkingPolicy({offThreshold:0.1,ambiguity:"off"})).toEqual({...DEFAULT_THINKING_POLICY,offThreshold:0.1,ambiguity:"off"});
    for (const value of [null,[],{offThreshold:0.8},{onThreshold:0.35},{offThreshold:-1},{onThreshold:1.1},{onThreshold:NaN},{timeoutMs:99},{timeoutMs:10001},{timeoutMs:200.5},{ambiguity:"maybe"},{typo:1}]) expect(()=>thinkingPolicy(value)).toThrow("invalid_settings");
    expect(DEFAULT_THINKING_POLICY.ambiguity).toBe("on");
  });
  it("bounds ordinary context while preserving the latest request and excluding system instructions",()=>{
    const context=judgeContext([{role:"system",content:"private system prompt"},...Array.from({length:10},(_,i)=>({role:"user" as const,content:String(i).repeat(8000)}))]);
    expect(context.length).toBeLessThanOrEqual(5);
    expect(context.reduce((n,m)=>n+m.content.length,0)).toBe(12000);
    expect(context.at(-1)?.content).toBe("9".repeat(8000));
    expect(JSON.stringify(context)).not.toContain("private system");
  });
  it.each([[0,false,"low_score"],[0.35,false,"low_score"],[0.5,true,"ambiguous"],[0.65,true,"high_score"],[1,true,"high_score"]])("routes score %s at the configured boundaries",async(score,enabled,reason)=>{
    let calls=0;
    const judge=new ClefThinkingJudge(ai(async(model,input)=>{
      calls++;expect(model).toBe(JUDGE_MODEL);expect(input.model).toBe("clef-flash");
      expect(input.state.messages).toEqual(messages);expect(input.questions.needs_thinking.type).toBe("noul");
      expect(input.tools).toBeUndefined();return response(score);
    }));
    expect(await judge.decide(messages,DEFAULT_THINKING_POLICY,signal())).toMatchObject({enabled,score,reason,usage:{neurons:3.455,source:"rate"}});
    expect(calls).toBe(1);
  });
  it("supports an explicit ambiguity override without changing failure fallback",async()=>{
    const policy=thinkingPolicy({ambiguity:"off"});
    expect((await new ClefThinkingJudge(ai(async()=>response(0.5))).decide(messages,policy,signal())).enabled).toBe(false);
    expect((await new ClefThinkingJudge(ai(async()=>{throw new Error("private provider error");})).decide(messages,policy,signal()))).toMatchObject({enabled:true,reason:"unavailable",usage:{neurons:null,source:"unmeasured"}});
  });
  it("preserves reported usage for malformed scores and prefers provider neurons over rate conversion",async()=>{
    for (const score of [null,"0.2",-0.1,1.1,NaN]) {
      const decision=await new ClefThinkingJudge(ai(async()=>response(score,{input_tokens:1000,neurons:2.2}))).decide(messages,DEFAULT_THINKING_POLICY,signal());
      expect(decision).toMatchObject({enabled:true,score:null,reason:"invalid_response",usage:{neurons:2.2,source:"provider"}});
    }
    expect(judgeUsage({input_tokens:0})).toMatchObject({neurons:0,source:"rate"});
    expect(judgeUsage({input_tokens:-1})).toMatchObject({neurons:null,source:"unmeasured"});
    expect(judgeUsage({input_tokens:"1000"})).toMatchObject({neurons:null,source:"unmeasured"});
  });
  it("bounds waiting when the provider ignores cancellation and never retries",async()=>{
    let calls=0,requestSignal:AbortSignal|undefined;
    const judge=new ClefThinkingJudge(ai((_model,_input,options)=>{calls++;requestSignal=options.signal;return new Promise(()=>{});}));
    const decision=await judge.decide(messages,thinkingPolicy({timeoutMs:100}),signal());
    expect(decision).toMatchObject({enabled:true,reason:"timeout",usage:{neurons:null}});
    expect(decision.durationMs).toBeGreaterThanOrEqual(90);expect(calls).toBe(1);expect(requestSignal?.aborted).toBe(true);
  });
  it("propagates a parent cancellation instead of making a new inference decision",async()=>{
    const controller=new AbortController();controller.abort();let calls=0;
    await expect(new ClefThinkingJudge(ai(async()=>{calls++;return response(0);})).decide(messages,DEFAULT_THINKING_POLICY,controller.signal)).rejects.toThrow();
    expect(calls).toBe(0);
    const running=new AbortController();
    const pending=new ClefThinkingJudge(ai(()=>new Promise(()=>{}))).decide(messages,DEFAULT_THINKING_POLICY,running.signal);
    running.abort();await expect(pending).rejects.toThrow();
  });
});
