/// <reference path="./modules.d.ts" />
import createRuby from './generated/niao-ruby.js';
import wasm from './generated/niao-ruby.wasm';
import type { ExecuteRubyResult, ExecutionTimings, RubyModule } from './types';
const errors = ['runtime_trap', 'instruction_limit', 'output_limit', 'syntax_error', 'ruby_error', 'unsupported_result', 'source_limit', 'initialization_error'];
export function failure(error: string): ExecuteRubyResult {
  return {ok:false,error,stdout:'',stderr:error,exitCode:1,instructions:0,
    timings:{wasmInitMs:0,vmInitMs:0,compileMs:0,evalMs:0,serializeMs:0,totalMs:0}};
}
// The imported compiled module is immutable and shared. All instance memory is per call.
export async function executeRuby(request: unknown): Promise<ExecuteRubyResult> {
  if (!request || typeof request !== 'object' || !('code' in request) || typeof request.code !== 'string') return failure('invalid_source');
  const code = request.code;
  if (!code.trim() || code.length > 8192 || code.includes('\0')) return failure('invalid_source');
  const bytes = new TextEncoder().encode(code);
  if (bytes.length > 8192) return failure('invalid_source');
  const start = performance.now();
  const marks = [start,start,start,start,start];
  let ruby: RubyModule | undefined;
  let lastPhase = -1;
  let log = '', logSize = 0;
  const decoder = new TextDecoder();
  const timings: ExecutionTimings = {wasmInitMs:0,vmInitMs:0,compileMs:0,evalMs:0,serializeMs:0,totalMs:0};
  let result: ExecuteRubyResult;
  try {
    ruby = await createRuby({
      instantiateWasm(imports, done) {
        const instance = new WebAssembly.Instance(wasm, imports);
        done(instance, wasm); return instance.exports;
      },
      // Compiler diagnostics may contain source text; never forward them to host logs.
      print: () => {}, printErr: () => {},
    });
    timings.wasmInitMs = performance.now() - start;
    ruby.niaoPhase = phase => { lastPhase = phase; marks[phase] = performance.now(); };
    ruby.niaoLog = bytes => {
      logSize += bytes.length;
      if (logSize > 4096) throw new Error('output_limit');
      log += decoder.decode(bytes, {stream:true});
    };
    const ptr = ruby._malloc(bytes.length + 1);
    if (!ptr) throw new Error('memory_limit');
    ruby.HEAPU8.set(bytes, ptr); ruby.HEAPU8[ptr + bytes.length] = 0;
    const value = ruby._niao_eval(ptr);
    const reason = ruby._niao_reason();
    const serializeStart = performance.now();
    const stats = {instructions:ruby._niao_count(),stdout:log + decoder.decode(),timings};
    result = reason || !value
      ? {...failure(errors[reason] ?? 'runtime_trap'),...stats}
      : {ok:true,value:new TextDecoder().decode(ruby.HEAPU8.subarray(value,value + ruby._niao_result_len())),stderr:'',exitCode:0,...stats};
    // Exercise JSON serialization to measure a portable approximation of result encoding.
    // The RPC transport performs its own structured serialization outside this measurement.
    JSON.stringify(result);
    timings.serializeMs = performance.now() - serializeStart;
  } catch {
    const reason = ruby?._niao_reason() ?? 0;
    result = {...failure(errors[reason] ?? 'runtime_trap'),stdout:log + decoder.decode(),instructions:ruby?._niao_count() ?? 0,timings};
  } finally {
    if (lastPhase >= 0 && lastPhase < 3) marks[lastPhase + 1] = performance.now();
    // Do not call Ruby cleanup/ensure after traps. No instance is cached; release host
    // references and let GC reclaim the entire linear memory, including compiler allocations.
    if (ruby) { ruby.niaoLog = undefined; ruby.niaoPhase = undefined; }
    ruby = undefined;
  }
  timings.vmInitMs = Math.max(0,marks[1]-marks[0]);
  timings.compileMs = Math.max(0,marks[2]-marks[1]);
  timings.evalMs = Math.max(0,marks[3]-marks[2]);
  timings.totalMs = performance.now() - start;
  return result;
}
