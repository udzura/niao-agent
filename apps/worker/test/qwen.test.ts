import {describe,it,expect} from 'vitest';
import {WorkersAIModel,modelThinkingOptions,isModelID,supportsThinking} from '../src/model';
const qwen='@cf/qwen/qwen3.8-27b';
const frame=(delta:unknown)=>`data: ${JSON.stringify({choices:[{delta}]})}\n\n`;
const stream=(text:string)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(text));c.close();}});
describe('Qwen 3.8 integration',()=>{
 it('is selectable and maps ON/OFF without inheriting xhigh or sending unsupported none',()=>{
  expect(isModelID(qwen)).toBe(true);expect(supportsThinking(qwen)).toBe(true);
  expect(modelThinkingOptions(qwen,false)).toEqual({chat_template_kwargs:{enable_thinking:false},max_completion_tokens:2048});
  expect(modelThinkingOptions(qwen,true)).toEqual({chat_template_kwargs:{enable_thinking:true},reasoning_effort:'low',max_completion_tokens:8192});
 });
 it.each([false,true])('streams content and structured reasoning for enabled=%s across tool continuations',async enabled=>{
  let calls=0;
  const ai={run:async(id:string,input:any)=>{
   expect(id).toBe(qwen);expect(input.chat_template_kwargs.enable_thinking).toBe(enabled);
   expect(input.reasoning_effort).toBe(enabled?'low':undefined);
   const round=calls++;
   if(round){expect(input.messages.at(-1)).toMatchObject({role:'tool',content:'{"ok":true,"value":"391"}'});
    expect(JSON.stringify(input.messages)).not.toContain('private thinking');}
   return stream((enabled?frame({reasoning_content:'private thinking'}):'')+(round?frame({content:'391です。'}):frame({tool_calls:[{index:0,id:'ruby',function:{name:'ruby_eval',arguments:'{"code":"17*23"}'}}]}))+'data: [DONE]\n\n');
  }} as unknown as Ai;
  const events=[];
  for await(const e of new WorkersAIModel(ai,qwen,async()=>({ok:true,value:'391'}),enabled).stream([],new AbortController().signal))events.push(e);
  expect(calls).toBe(2);expect(events).toContainEqual({text:'391です。'});
  expect(events.filter(e=>'thinking'in e && e.thinking.text)).toHaveLength(enabled?2:0);
  if(enabled)expect(events).toContainEqual({thinking:{generation:1,text:'private thinking',active:true}});
 });
});
