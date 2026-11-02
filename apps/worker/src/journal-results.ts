import {z} from "zod";
import {getAgentByName} from "agents";
import type {Env} from "./index";
const result=z.strictObject({v:z.literal(1),kind:z.literal("journal_agent_result"),jobId:z.uuid(),reportSessionId:z.uuid()});
export async function consumeJournalResults(batch:MessageBatch<unknown>,env:Env) {
  for(const message of batch.messages){
    const parsed=result.safeParse(message.body);if(!parsed.success){message.ack();continue;}
    try{
      if(!env.JournalAgent)throw Error("not_configured");
      const journal=await getAgentByName(env.JournalAgent,parsed.data.reportSessionId);
      const text=await journal.result(parsed.data.jobId);if(!text)throw Error("result_unavailable");
      const main=await getAgentByName(env.NiaoAgent,"personal");
      const review=await journal.review(parsed.data.jobId);
      await main.completeJournalAgentJob(parsed.data.jobId,parsed.data.reportSessionId,text,review);message.ack();
    }catch{message.retry({delaySeconds:60});}
  }
}
