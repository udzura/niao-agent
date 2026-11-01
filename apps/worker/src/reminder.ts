import {z} from "zod";
import type {AdditionalTool} from "./past-logs";

const input = z.strictObject({
  minutes:z.number().int().min(1).max(43200).describe("Number of minutes from now, from 1 to 43200 (30 days)."),
  message:z.string().trim().min(1).max(1000).describe("The reminder text to deliver to this conversation."),
});
export function reminderTool(enqueue:(minutes:number,message:string)=>Promise<unknown>):AdditionalTool {
  const {$schema,...parameters}=z.toJSONSchema(input,{io:"input"});
  return {definition:{type:"function",function:{name:"set_reminder",parameters,
    description:"Schedule a reminder in this conversation after the requested number of minutes. Use when the user explicitly asks to be reminded. Pass the reminder content in their language. Confirm only if the result says ok:true. The reminder appears in conversation history, not as an OS push notification."}},
    execute:async(args,signal)=>{signal.throwIfAborted();const parsed=input.safeParse(args);
      if(!parsed.success)return {ok:false,error:"invalid_tool_arguments"};
      return enqueue(parsed.data.minutes,parsed.data.message);
    }};
}
