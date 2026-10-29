// Local-only probe: exercises the real application adapter + Service Binding, without AI calls.
import {rubyExecutor} from '../../../apps/worker/src/ruby/tool';
import type RubyRunner from '../../../apps/ruby-runner/src/index';
export default {
  async fetch(request: Request, env: {RUBY_RUNNER: Service<RubyRunner>}) {
    const example = new URL(request.url).searchParams.get('example');
    const code = example === 'random'
      ? 'r = Random.new(123); Array.new(5) { r.rand(100) }.join(",")'
      : example === 'time' ? 'puts Time.now.utc.to_s; Time.utc(2026,10,28).to_i' : '1 + 1';
    return Response.json(await rubyExecutor(env.RUBY_RUNNER)(code,new AbortController().signal));
  },
};
