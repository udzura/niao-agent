// Official Workers AI pricing snapshot. Persist the rates with each attempt so
// a later price/model change never silently rewrites historical estimates.
export const JOURNAL_MODEL="@cf/google/gemma-4-26b-a4b-it";
export const JOURNAL_USAGE_RATES={model:JOURNAL_MODEL,asOf:"2026-11-03",inputPerMillion:9091,outputPerMillion:27273};
export interface JournalUsageSnapshot {
  trackingSince:string;
  summary:{attempts:number;incompleteAttempts:number;unmeasuredAttempts:number;reportedAttempts:number;estimatedAttempts:number;
    reportedNeurons:number;estimatedNeurons:number;inputTokens:number;outputTokens:number;trackedJobs:number;unfinishedJobs:number;
    untrackedJobs:number;complete:boolean;source:string;neurons:number|null;recordedNeurons:number};
  attempts?:{cursor:number;id:string;jobId:string;model:string;round:number;startedAt:string;finishedAt:string|null;status:string;
    inputTokens:number|null;outputTokens:number|null;totalTokens:number|null;neurons:number|null;source:string;rates:typeof JOURNAL_USAGE_RATES}[];
  hasMore?:boolean;
  nextCursor?:number|null;
}
export const numericUsage=(usage:Record<string,number>)=>Object.fromEntries(
  ["prompt_tokens","completion_tokens","total_tokens","neurons"].flatMap(key=>{
    const value=usage[key];
    return typeof value==="number" && Number.isFinite(value) && value>=0 && value<=Number.MAX_SAFE_INTEGER
      && (key==="neurons" || Number.isInteger(value)) ? [[key,value]] : [];
  }));
export function measureUsage(usage:Record<string,number>){
  const values=numericUsage(usage);
  if(values.neurons!==undefined)return {neurons:values.neurons,source:"reported" as const};
  if(values.prompt_tokens!==undefined && values.completion_tokens!==undefined)
    return {neurons:(values.prompt_tokens*JOURNAL_USAGE_RATES.inputPerMillion+values.completion_tokens*JOURNAL_USAGE_RATES.outputPerMillion)/1e6,source:"estimated" as const};
  return {neurons:null,source:"unavailable" as const};
}
