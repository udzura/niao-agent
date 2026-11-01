import {describe,it,expect,vi} from 'vitest';
import {WorkersAIModel,modelThinkingOptions,isModelID,supportsThinking} from '../src/model';
const models=['@cf/meta/llama-3.3-70b-instruct-fp8-fast','@cf/ibm-granite/granite-4.0-h-micro','@cf/meta/llama-4-scout-17b-16e-instruct'] as const;
const frame=(value:unknown)=>`data: ${JSON.stringify(value)}\n\n`;
function stream(text:string){
 const bytes=new TextEncoder().encode(text);
 return new ReadableStream<Uint8Array>({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}});
}
describe.each(models)('%s integration',model=>{
 it('is selectable without Thinking-specific generation options',()=>{
  expect(isModelID(model)).toBe(true);expect(supportsThinking(model)).toBe(false);
  for(const enabled of [false,true])expect(modelThinkingOptions(model,enabled)).toEqual({max_tokens:2048});
 });
 it.each(['legacy','openai'])('streams Japanese %s text and usage without leaking reasoning',async format=>{
  const ai={run:vi.fn(async(id,input)=>{
   expect(id).toBe(model);expect(input.max_tokens).toBe(2048);
   for(const key of ['chat_template_kwargs','max_completion_tokens','reasoning_effort','tools'])expect(input).not.toHaveProperty(key);
   return stream(frame({choices:[{delta:{reasoning_content:'private reasoning'}}]})+
    frame(format==='legacy'?{response:'こんにちは😀'}:{choices:[{delta:{content:'こんにちは😀'}}]})+
    frame({usage:{prompt_tokens:3,completion_tokens:4,total_tokens:7,neurons:0.5}})+'data: [DONE]\n\n');
  })} as unknown as Ai;
  const events=[];
  for await(const event of new WorkersAIModel(ai,model,undefined,true).stream([],new AbortController().signal))events.push(event);
  expect(events).toEqual([{text:'こんにちは😀'},{usage:{prompt_tokens:3,completion_tokens:4,total_tokens:7,neurons:0.5}}]);
 });
 it.each([false,true])('executes fragmented tool calls once when mirrored legacy fields=%s',async mirrored=>{
  let calls=0;const execute=vi.fn(async()=>({ok:true,value:'391'}));
  const ai={run:async(id:string,input:any)=>{
   expect(id).toBe(model);expect(input.max_tokens).toBe(2048);
   expect(input.tools[0].function.name).toBe('ruby_eval');
   if(calls++===0)return stream(
    frame({choices:[{delta:{tool_calls:[{index:0,id:'ruby-test',function:{name:'ruby_',arguments:'{"code":"17'}}]}}],...(mirrored?{tool_calls:[{name:'ruby_',arguments:'{"code":"17'}]}:{})})+
    frame({choices:[{delta:{tool_calls:[{index:0,function:{name:'eval',arguments:'*23"}'}}]}}],...(mirrored?{tool_calls:[{name:'eval',arguments:'*23"}'}]}:{})})+'data: [DONE]\n\n');
   expect(input.messages.at(-2)).toMatchObject({role:'assistant',tool_calls:[{id:'ruby-test',function:{name:'ruby_eval',arguments:'{"code":"17*23"}'}}]});
   expect(input.messages.at(-1)).toEqual({role:'tool',tool_call_id:'ruby-test',content:'{"ok":true,"value":"391"}'});
   return stream(frame({choices:[{delta:{content:'391です。'}}]})+'data: [DONE]\n\n');
  }} as unknown as Ai;
  const events=[];
  for await(const e of new WorkersAIModel(ai,model,execute).stream([],new AbortController().signal))events.push(e);
  expect(execute).toHaveBeenCalledOnce();expect(execute.mock.calls[0][0]).toBe('17*23');
  expect(calls).toBe(2);expect(events).toContainEqual({text:'391です。'});
 });
});
