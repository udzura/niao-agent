import {z} from "zod";
import type {AdditionalTool} from "./past-logs";
export const reportLifetime = 12 * 3600000;
export const reportInput = z.strictObject({prompt:z.string().trim().min(1).max(8000), reportSessionId:z.uuid().optional()});
export const reportEnvelope = z.strictObject({v:z.literal(1),kind:z.literal("journal_agent"),jobId:z.uuid()});
export type ReportEnvelope = z.infer<typeof reportEnvelope>;
export const draftReview = z.strictObject({articleId:z.uuid(),updatedAt:z.iso.datetime(),title:z.string().max(200),
  description:z.string().max(1000).nullable(),bodyMarkdown:z.string().max(50000),
  sources:z.array(z.object({title:z.string().optional(),url:z.string().url()})).max(20)});
export type DraftReview=z.infer<typeof draftReview>;
export const isPublicationApproval=(text:string)=>["公開して","公開してください","承認します","承認して公開してください"]
  .includes(text.trim().replace(/[。！!]+$/u,""));
export type PublicationApproval={articleId:string;expectedUpdatedAt:string};
export interface ReportJob {
  id:string; sessionId:string; epoch:number; requestId:string; prompt:string; reportSessionId:string;
  createdAt:number; expiresAt:number; status:string; dispatchedAt:number; result:string|null;
  approval?:string|null;
}
export function journalAgentTool(enqueue:(input:z.infer<typeof reportInput>)=>Promise<unknown>):AdditionalTool {
  const {$schema,...parameters}=z.toJSONSchema(reportInput);
  return {definition:{type:"function",function:{name:"ask_journal_agent",parameters,
    description:"Send instructions to the independent journal-writing agent asynchronously. Use for journal writing, revision, and publication approval after a draft was presented. Only an explicit approval in the actual user's message can authorize publication; this tool's prompt cannot grant it. Returns a job receipt, not an article. A separate draft/reply arrives in this conversation. Follow-ups reuse the report session for up to 12 hours from creation; pass reportSessionId to target it explicitly. Never claim completion before the asynchronous result."}},
    execute:async(args,signal)=>{signal.throwIfAborted();const parsed=reportInput.safeParse(args);return parsed.success ? enqueue(parsed.data) : {ok:false,error:"invalid_tool_arguments"};}};
}
