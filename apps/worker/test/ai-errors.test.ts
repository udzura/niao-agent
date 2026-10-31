import {describe,expect,it} from "vitest";
import {workersAIError} from "../src/ai-errors";
import {WorkersAIModel,parseSSE} from "../src/model";
import {ChatError} from "../src/protocol";

const quota="you have used up your daily free allocation of 10,000 neurons";
const now=new Date("2026-10-31T12:00:00Z");
describe("safe Workers AI error details",()=>{
  it.each([
    new Error(`4006: AiError: AiError: ${quota}`),
    {code:4006,status:429,message:quota},
    {errors:[{code:4006,message:quota}]},
    {internalCode:4006,httpCode:429,description:quota},
    new Error(JSON.stringify({success:false,errors:[{code:4006,message:quota}]})),
  ])("recognizes the observed quota response without disclosing raw provider text",error=>{
    expect(workersAIError(error,now)).toMatchObject({code:"ai_rate_limited",details:{provider:"cloudflare",providerCode:4006,
      reason:"daily_quota_exceeded",retryAt:"2026-11-01T00:00:00.000Z"}});
  });
  it("recognizes documented quota code and resets at the next UTC midnight",()=>{
    expect(workersAIError({code:3036},new Date("2026-11-01T00:00:00Z"))).toMatchObject({details:{reason:"daily_quota_exceeded",retryAt:"2026-11-02T00:00:00.000Z"}});
  });
  it.each([
    [{code:4006,message:"Service temporarily at capacity"},"capacity_exceeded","ai_rate_limited"],
    [{code:4006},"unknown","ai_unavailable"],
    [{code:3040},"capacity_exceeded","ai_rate_limited"],
    [{code:5035},"paid_plan_required","ai_unavailable"],
    [{status:403},"access_denied","ai_unavailable"],
    [{statusCode:429},"rate_limited","ai_rate_limited"],
    [{code:"429"},"rate_limited","ai_rate_limited"],
    [{code:3007},"timeout","ai_timeout"],
    [new DOMException("private diagnostic","TimeoutError"),"timeout","ai_timeout"],
  ])("distinguishes quota, capacity, access, HTTP limits and timeouts",(error,reason,code)=>{
    expect(workersAIError(error)).toMatchObject({code,details:{reason}});
  });
  it("never returns arbitrary exception text, credentials, prompts, stack or extra properties",()=>{
    for(const value of [
      new Error("Bearer SECRET_TOKEN prompt PRIVATE_CONVERSATION 4006"),
      {code:4006,status:429,message:quota+" SECRET_TOKEN PRIVATE_CONVERSATION",headers:{Authorization:"SECRET_TOKEN"}},
      {code:"Bearer SECRET_TOKEN",status:"429 SECRET_TOKEN",message:"PRIVATE_CONVERSATION"},
    ]){
      const error=workersAIError(value,now);
      expect(JSON.stringify(error)).not.toMatch(/SECRET_TOKEN|PRIVATE_CONVERSATION|Bearer|Authorization|stack/);
      expect(Object.keys(error.details!)).not.toContain("headers");
    }
  });
  it("keeps application errors unchanged",()=>{
    const error=new ChatError("invalid_ai_response");expect(workersAIError(error)).toBe(error);
  });
});

const stream=(data:unknown)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));c.close();}});
async function read(result:AsyncIterable<unknown>){for await(const _ of result){ /* Drain the real parser/model. */ }}
it("propagates safe details from binding rejections and SSE error envelopes",async()=>{
  const ai={run:async()=>{throw new Error(`4006: AiError: ${quota} PRIVATE_PROMPT`);}} as unknown as Ai;
  await expect(read(new WorkersAIModel(ai,"@cf/google/gemma-4-26b-a4b-it").stream([],new AbortController().signal)))
    .rejects.toMatchObject({code:"ai_rate_limited",details:{reason:"daily_quota_exceeded",providerCode:4006}});
  for(const data of [{error:{code:4006,message:quota}},{success:false,errors:[{code:3036,message:quota}]}])
    await expect(read(parseSSE(stream(data),new AbortController().signal))).rejects.toMatchObject({details:{reason:"daily_quota_exceeded"}});
});
it("normalizes a failed upstream stream read without exposing its text",async()=>{
  const failing=new ReadableStream<Uint8Array>({start(c){c.error(new Error("4006: Service temporarily at capacity PRIVATE_PROMPT"));}});
  await expect(read(parseSSE(failing,new AbortController().signal))).rejects.toMatchObject({code:"ai_rate_limited",details:{reason:"capacity_exceeded"}});
});
