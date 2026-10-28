export interface ExecuteRubyRequest { code: string }
export interface ExecutionTimings {
  wasmInitMs: number;
  vmInitMs: number;
  compileMs: number;
  evalMs: number;
  serializeMs: number;
  totalMs: number;
}
export interface ExecuteRubyResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  value?: string;
  error?: string;
  instructions: number;
  // Elapsed time, NOT CPU time. Worker clocks may remain frozen during synchronous execution.
  timings: ExecutionTimings;
}
export interface RubyModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _niao_eval(ptr: number): number;
  _niao_reason(): number;
  _niao_count(): number;
  _niao_result_len(): number;
  niaoLog?: (bytes: Uint8Array) => void;
  niaoPhase?: (phase: number) => void;
}
export interface RubyModuleOptions {
  instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void): WebAssembly.Exports;
  print(text: string): void;
  printErr(text: string): void;
}
