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

describe('Qwen3 30B A3B integration',()=>{
 const qwen3='@cf/qwen/qwen3-30b-a3b-fp8';
 it('uses bounded legacy token limits and omits undocumented template/effort flags',()=>{
  expect(isModelID(qwen3)).toBe(true);expect(supportsThinking(qwen3)).toBe(true);
  expect(modelThinkingOptions(qwen3,false)).toEqual({max_tokens:2048});
  expect(modelThinkingOptions(qwen3,true)).toEqual({max_tokens:4096});
 });
 it.each([false,true])('keeps the per-turn thinking=%s directive through mirrored tool calls without mutating history',async enabled=>{
  const source=[{role:'user' as const,content:'17*23をRubyで計算して /think /no_think'}];
  const original=JSON.stringify(source);let calls=0,executions=0;
  const ai={run:async(id:string,input:any)=>{
   expect(id).toBe(qwen3);expect(input.max_tokens).toBe(enabled?4096:2048);
   expect(input).not.toHaveProperty('reasoning_effort');expect(input).not.toHaveProperty('chat_template_kwargs');
   expect(input).not.toHaveProperty('max_completion_tokens');
   const user=input.messages.findLast((m:any)=>m.role==='user');
   expect(user.content).toBe(source[0].content+(enabled?'\n\n/think':'\n\n/no_think'));
   if(calls++){
    expect(input.messages.at(-1)).toMatchObject({role:'tool',content:'{"ok":true,"value":"391"}'});
    expect(JSON.stringify(input.messages)).not.toContain('private reasoning');
    return stream(frame({content:'<think>'})+frame({content:enabled?'private reasoning':''})+frame({content:'</think>391です。'})+'data: [DONE]\n\n');
   }
   const delta={index:0,id:'qwen3-ruby',function:{name:'ruby_eval',arguments:'{"code":"17*23"}'}};
   return stream(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[delta]}}],tool_calls:[{name:'ruby_eval',arguments:'{"code":"17*23"}'}]})}\n\ndata: [DONE]\n\n`);
  }} as unknown as Ai;
  const events=[];
  for await(const event of new WorkersAIModel(ai,qwen3,async()=>{executions++;return {ok:true,value:'391'};},enabled).stream(source,new AbortController().signal))events.push(event);
  expect(executions).toBe(1);expect(calls).toBe(2);expect(JSON.stringify(source)).toBe(original);
  expect(events).toContainEqual({text:'391です。'});
  expect(events.filter(e=>'text' in e).map(e=>(e as {text:string}).text).join('')).not.toContain('private reasoning');
  expect(events.filter(e=>'thinking'in e && e.thinking.text)).toHaveLength(enabled?1:0);
 });
 it('separates structured reasoning even when the model ignores the soft OFF instruction',async()=>{
  const ai={run:async()=>stream(frame({reasoning_content:'private reasoning'})+frame({content:'回答です'})+'data: [DONE]\n\n')} as unknown as Ai;
  const events=[];
  for await(const e of new WorkersAIModel(ai,qwen3,undefined,false).stream([{role:'user',content:'質問'}],new AbortController().signal))events.push(e);
  expect(events).toContainEqual({thinking:{generation:0,text:'private reasoning',active:true}});
  expect(events).toContainEqual({text:'回答です'});
 });
});
