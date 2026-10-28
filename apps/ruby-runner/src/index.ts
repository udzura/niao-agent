import { WorkerEntrypoint } from 'cloudflare:workers';
import { executeRuby, failure } from './execute';
import type { ExecuteRubyRequest, ExecuteRubyResult } from './types';
let busy = false; // Per-isolate admission control, not a global lock or memory guarantee.
export default class RubyRunner extends WorkerEntrypoint {
  async execute(request: ExecuteRubyRequest): Promise<ExecuteRubyResult> {
    if (busy) return failure('runner_busy');
    busy = true;
    try { return await executeRuby(request); }
    finally { busy = false; }
  }
  async fetch(): Promise<Response> { return new Response('Not found', {status:404}); }
}
