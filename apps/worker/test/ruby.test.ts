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

describe('bundled mruby-random and mruby-time in the real RPC/Wasm runtime', () => {
  it('supports reproducible seeded generators and Kernel srand/rand', async () => {
    const code = 'srand(123); a = Array.new(8) { rand(10000) }; srand(123); b = Array.new(8) { rand(10000) }; r = Random.new(123); c = Array.new(8) { r.rand(10000) }; a == b && b == c';
    expect(await run(code)).toMatchObject({ok:true,value:'true'});
    const sequence = 'r = Random.new(42); Array.new(8) { r.rand(10000) }.join(",")';
    const first = await run(sequence);
    await run('srand(999); 100.times { rand }; 1');
    expect(await run(sequence)).toMatchObject({ok:true,value:first.value});
  });
  it.each([
    ['implicit seed/range', 'r = Random.new; a = Array.new(50) { r.rand(2..5) }; a.all? { |n| n >= 2 && n <= 5 }'],
    ['Kernel float rand', 'r = rand; r >= 0 && r < 1'],
    ['shuffle', '[1,2,3].shuffle.sort == [1,2,3]'],
    ['sample', '[1,2,3].include?([1,2,3].sample)'],
    ['random bytes', 'Random.new.bytes(16).bytesize == 16'],
  ])('supports %s',async (_name,code) => {
    expect(await run(code)).toMatchObject({ok:true,value:'true'});
  });
  it('calculates explicit UTC dates and epoch arithmetic',async () => {
    const expected = String(Date.UTC(2026,9,28,13,26,15)/1000);
    expect(await run('Time.utc(2026,10,28,13,26,15).to_i')).toMatchObject({ok:true,value:expected});
    expect(await run('t = Time.at(0).utc; [t.year,t.month,t.day,t.hour,t.min,t.sec,(t+90).to_i].join(",")')).toMatchObject({ok:true,value:'1970,1,1,0,0,0,90'});
  });
  it('reads the actual host clock through Time.now and captures time output',async () => {
    const before = Math.floor(Date.now()/1000);
    const result = await run('puts Time.now.to_i; Time.now.to_i');
    expect(result.ok).toBe(true);
    expect(Number(result.value)).toBeGreaterThanOrEqual(before - 2);
    expect(Number(result.value)).toBeLessThanOrEqual(Math.floor(Date.now()/1000) + 2);
    expect(result.stdout).toMatch(/^\d+\n$/);
  });
  it('keeps gem monkey patches and global seed variables local to an execution',async () => {
    expect(await run('class Time; def self.niao_marker; 1; end; end; $niao_seed = srand(123); 1')).toMatchObject({ok:true,value:'1'});
    expect(await run('$niao_seed')).toMatchObject({ok:true,value:'null'});
    expect(await run('Time.niao_marker')).toMatchObject({ok:false,error:'ruby_error'});
  });
  it('still stops random/time loops and oversized allocations/results',async () => {
    expect(await run('loop { rand; Time.now }')).toMatchObject({ok:false,error:'instruction_limit'});
    expect(await run('Random.new(1).bytes(9000)')).toMatchObject({ok:false,error:'output_limit'});
    expect((await run('Random.new(1).bytes(100000000)')).ok).toBe(false);
    expect(await run('Time.at(0).to_i')).toMatchObject({ok:true,value:'0'});
  });
});
