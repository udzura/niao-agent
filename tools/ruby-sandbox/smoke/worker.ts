// Local-only probe: exercises the real application adapter + Service Binding, without AI calls.
import {rubyExecutor} from '../../../apps/worker/src/ruby/tool';
import type RubyRunner from '../../../apps/ruby-runner/src/index';
export default {
  async fetch(_request: Request, env: {RUBY_RUNNER: Service<RubyRunner>}) {
    return Response.json(await rubyExecutor(env.RUBY_RUNNER)('1 + 1',new AbortController().signal));
  },
};
