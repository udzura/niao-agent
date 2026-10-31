import {ChatError,type AIErrorDetails} from "./protocol";

// Only call at the Workers AI boundary. Arbitrary exception text can contain
// echoed prompts, tokens or headers; extract bounded numeric fields and classify
// known phrases, then return our own message. Never return the raw string/stack.
export function workersAIError(error:unknown,now=new Date()):ChatError {
  if (error instanceof ChatError) return error;
  let value = error as {code?:unknown;internalCode?:unknown;status?:unknown;statusCode?:unknown;httpCode?:unknown;
    message?:unknown;description?:unknown;name?:unknown;errors?:unknown[];error?:unknown}|null;
  let message = typeof error === "string" ? error : typeof value?.message === "string" ? value.message : "";
  message = message.slice(0,8192);
  if (message.trimStart().startsWith("{")) {
    try { const parsed=JSON.parse(message); if (parsed && typeof parsed === "object") value=parsed; } catch { /* Not a JSON envelope. */ }
  }
  let item = value;
  if (Array.isArray(value?.errors)) item=value.errors[0] as typeof value;
  else if (value?.error && typeof value.error === "object") item=value.error as typeof value;
  if (typeof item?.message === "string") message=item.message.slice(0,8192);
  else if (typeof item?.description === "string") message=item.description.slice(0,8192);
  const numeric = (input:unknown,min:number,max:number) => {
    const n=typeof input === "number" ? input : typeof input === "string" && /^\d{3,5}$/.test(input) ? Number(input) : NaN;
    return Number.isInteger(n) && n>=min && n<=max ? n : undefined;
  };
  // Binding errors commonly use "4006: AiError: ..." without a status property.
  const prefix=message.match(/^\s*(?:(?:AiError|Error|InferenceUpstreamError):\s*)*(\d{4,5}):/i);
  const providerCode=numeric(item?.internalCode ?? item?.code,1000,99999) ?? numeric(prefix?.[1],1000,99999);
  const httpStatus=numeric(value?.httpCode ?? value?.status ?? value?.statusCode ?? item?.httpCode ?? item?.status ?? item?.statusCode,100,599)
    ?? numeric(item?.code,100,599);
  const details:AIErrorDetails={provider:"cloudflare",reason:"unknown",message:"Workers AI could not generate a response.",
    ...(providerCode!==undefined ? {providerCode} : {}),...(httpStatus!==undefined ? {httpStatus} : {})};
  let code="ai_unavailable";
  // 4006 is ambiguous: observed for BOTH quota exhaustion and service capacity.
  // Do not classify it as a quota error without the quota-specific wording.
  if (providerCode===3036 || /used up your daily free allocation of (?:10,?000) neurons/i.test(message)) {
    code="ai_rate_limited";details.reason="daily_quota_exceeded";
    details.message="The daily free allocation of 10,000 Workers AI Neurons has been exhausted. It resets at 00:00 UTC.";
    const reset=new Date(now);reset.setUTCHours(24,0,0,0);details.retryAt=reset.toISOString();
  } else if (providerCode===3040 || /(?:temporarily at capacity|capacity temporarily exceeded|out of capacity)/i.test(message)) {
    code="ai_rate_limited";details.reason="capacity_exceeded";details.message="Workers AI is temporarily out of capacity. Try again later.";
  } else if (providerCode===5035) {
    details.reason="paid_plan_required";details.message="This Workers AI model requires the Workers Paid plan.";
  } else if ([5018,5016,3023,3041].includes(providerCode!) || httpStatus===401 || httpStatus===403) {
    details.reason="access_denied";details.message="Workers AI denied access. Check account permissions and model access requirements.";
  } else if ([3007,3008].includes(providerCode!) || httpStatus===408 || httpStatus===504 || ["TimeoutError","AbortError"].includes(String(value?.name))) {
    code="ai_timeout";details.reason="timeout";details.message="The Workers AI request timed out or was aborted.";
  } else if (httpStatus===429) {
    code="ai_rate_limited";details.reason="rate_limited";details.message="Workers AI rate-limited the request. Try again later.";
  }
  return new ChatError(code,details);
}
