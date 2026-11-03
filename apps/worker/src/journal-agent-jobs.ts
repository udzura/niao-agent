import {z} from "zod";
import type {AdditionalTool} from "./past-logs";
export const reportLifetime = 12 * 3600000;
export const reportInput = z.strictObject({prompt:z.string().trim().min(1).max(8000), reportSessionId:z.uuid().optional()});
export const reportUsageQuery=z.strictObject({reportSessionId:z.uuid().optional(),jobId:z.uuid().optional(),
  before:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit:z.coerce.number().int().min(1).max(20).default(10)})
  .refine(value=>!(value.reportSessionId && value.jobId));
export const reportEnvelope = z.strictObject({v:z.literal(1),kind:z.literal("journal_agent"),jobId:z.uuid()});
export type ReportEnvelope = z.infer<typeof reportEnvelope>;
export const draftReview = z.strictObject({articleId:z.uuid(),updatedAt:z.iso.datetime(),title:z.string().max(200),
  description:z.string().max(1000).nullable(),bodyMarkdown:z.string().max(50000),
  sources:z.array(z.object({title:z.string().optional(),url:z.string().url()})).max(20)});
export type DraftReview=z.infer<typeof draftReview>;
const instructionText=(text:string)=>text.replace(/```[\s\S]*?```|`[^`]*`|「[^」]*」|『[^』]*』|"[^"\n]*"|“[^”]*”/gu,"")
  .replace(/^[ \t]*(?:>|引用[:：])[^\n]*$/gmu,"");
export const isPublicationDenial=(text:string)=>/公開(?:しない|しなく|しないで|しません|するな|はしない|を禁止|を保留|しないよう|しないこと)|公開(?:して)?(?:は|はいけ|ほしくない|欲しくない|しないで)/u.test(instructionText(text));
export const isPublicationApproval=(text:string)=>{
  const instruction=instructionText(text).trim();
  return !isPublicationDenial(instruction) && (/公開して(?:ください|下さい|ほしい|欲しい|くれ)?(?:[。！!、,\s]|$|と(?:伝|指示|依頼))/u.test(instruction)
    || /^承認します[。！!]*$/u.test(instruction));
};
// An explicit publication instruction can precede creation of the draft.
export type PublicationApproval={articleId?:string;expectedUpdatedAt?:string};
export interface ReportJob {
  id:string; sessionId:string; epoch:number; requestId:string; prompt:string; reportSessionId:string;
  createdAt:number; expiresAt:number; status:string; dispatchedAt:number; result:string|null;
  approval?:string|null;
}
export function journalAgentTool(enqueue:(input:z.infer<typeof reportInput>)=>Promise<unknown>):AdditionalTool {
  const {$schema,...parameters}=z.toJSONSchema(reportInput);
  return {definition:{type:"function",function:{name:"ask_journal_agent",parameters,
    description:"Send instructions to the independent journal-writing agent asynchronously. Use for journal writing, revision and publication. To publish, explicitly include 公開してください or 公開して下さい in the prompt; explicit publication instructions from either the user or this delegated prompt authorize publishing. Otherwise only save a draft. You may request writing/revision and publication together. Returns a job receipt, not an article; a separate reply arrives in this conversation. Follow-ups reuse the report session for up to 12 hours from creation; pass reportSessionId to target it explicitly. Never claim completion before the asynchronous result."}},
    execute:async(args,signal)=>{signal.throwIfAborted();const parsed=reportInput.safeParse(args);return parsed.success ? enqueue(parsed.data) : {ok:false,error:"invalid_tool_arguments"};}};
}
