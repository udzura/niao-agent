import {env} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';
import {rubyExecutor} from '../src/ruby/tool';
const run = (code: string) => rubyExecutor((env as any).RUBY_RUNNER)(code,new AbortController().signal) as Promise<any>;
describe('real isolated PicoRuby Wasm', () => {
  it('evaluates arithmetic, iteration and bounded diagnostic output', async () => {
    const r = await run('puts "hello"; (1..10).inject(0) { |s,n| s+n }');
    expect(r.ok).toBe(true); expect(r.value).toBe('55'); expect(r.stdout).toBe('hello\n'); expect(r.instructions).toBeGreaterThan(0);
  });
  it.each(['loop {}','begin; loop {}; rescue Exception; retry; end','begin; loop {}; ensure; loop {}; end'])('terminates runaway code: %s',async code => {
    const r = await run(code); expect(r.ok).toBe(false);
    expect(r.error).toBe('instruction_limit');
    expect(r.instructions).toBe(200001);
    expect((await run('6*7')).value).toBe('42');
  });
  it('bounds recursion', async () => { expect((await run('def f; f; end; f')).ok).toBe(false); });
  it('enforces output and memory limits',async () => {
    expect((await run('loop { puts "x" * 1000 }')).error).toBe('output_limit');
    expect((await run('"x" * 100000000')).ok).toBe(false);
  });
  it('rejects invalid source and syntax and isolates globals',async () => {
    expect((await run('x'.repeat(8193))).error).toBe('invalid_source');
    expect((await run('def')).error).toBe('syntax_error');
    expect((await run('$secret = 123; 1')).ok).toBe(true);
    expect((await run('$secret')).value).toBe('null');
  });
  it.each(['ENV["NIAO_TOKEN"]','File.read("/etc/passwd")','system("echo unsafe")','require "socket"','Cloudflare::Fetch.get("https://example.com")'])('provides no external capability: %s',async code => {
    expect((await run(code)).ok).toBe(false);
  });
});

describe('static Runner RPC contract', () => {
  const runner = () => (env as any).RUBY_RUNNER;
  it('returns arithmetic, stdout and stable error envelopes through RPC', async () => {
    expect(await runner().execute({code:'1 + 1'})).toMatchObject({ok:true,value:'2',stdout:'',stderr:'',exitCode:0});
    expect(await runner().execute({code:'puts "Hello from Niao!"'})).toMatchObject({ok:true,stdout:'Hello from Niao!\n',exitCode:0});
    expect(await runner().execute({code:'def foo('})).toMatchObject({ok:false,error:'syntax_error',stderr:'syntax_error',exitCode:1});
    expect(await runner().execute({code:'raise "something went wrong"'})).toMatchObject({ok:false,error:'ruby_error',stderr:'ruby_error',exitCode:1});
  });
  it('validates RPC inputs before allocating a VM, and has no HTTP execution API',async () => {
    for (const request of [null,{}, {code:5},{code:' '},{code:'x\0y'},{code:'あ'.repeat(3000)}]) {
      expect(await runner().execute(request)).toMatchObject({ok:false,error:'invalid_source',instructions:0});
    }
    expect((await runner().fetch('https://runner.invalid')).status).toBe(404);
  });
  it('preserves output before a Ruby error, and clears class definitions between requests', async () => {
    expect(await runner().execute({code:'puts "before"; raise "error"'})).toMatchObject({ok:false,stdout:'before\n',error:'ruby_error'});
    expect((await runner().execute({code:'class Hidden; end; 1'})).ok).toBe(true);
    expect((await runner().execute({code:'Hidden.new'})).error).toBe('ruby_error');
  });
  it('keeps the existing tool result shape without exposing RPC timing/error metadata',async () => {
    const result = await run('1 + 1');
    expect(Object.keys(result).sort()).toEqual(['instructions','ok','stdout','value']);
    expect(result.value).toBe('2');
  });
});
