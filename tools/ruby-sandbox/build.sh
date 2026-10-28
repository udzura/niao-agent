#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
: "${PICORUBY_ROOT:?Set PICORUBY_ROOT to a PicoRuby checkout with submodules}"
if [[ -d /opt/homebrew/opt/emscripten/libexec ]]; then
  export PATH="/opt/homebrew/opt/emscripten/libexec:$PATH"
fi
python3 - "$PICORUBY_ROOT" "$root/tools/ruby-sandbox/sources.json" <<'PYTHON'
import json, subprocess, sys
from pathlib import Path
for path, expected in json.load(open(sys.argv[2])).items():
    checkout = str(Path(sys.argv[1]) / path)
    actual = subprocess.check_output(['git', '-C', checkout, 'rev-parse', 'HEAD'], text=True).strip()
    if actual != expected or subprocess.call(['git', '-C', checkout, 'diff', '--quiet', 'HEAD']) != 0:
        raise SystemExit('Source revision mismatch or tracked changes: ' + path)
PYTHON
export NIAO_SANDBOX_ROOT="$root/tools/ruby-sandbox"
# PicoRuby's build writes generated files into its source tree; copy to Niao first.
mkdir -p "$root/build/picoruby"
rsync -a --exclude .git --exclude /build --exclude /bin --exclude .bundle --exclude mrbgems/picoruby-worker-wasm "$PICORUBY_ROOT/" "$root/build/picoruby/"
cd "$root/build/picoruby"
MRUBY_CONFIG="$NIAO_SANDBOX_ROOT/build_config.rb" rake > "$root/build/ruby-build.log" 2>&1
cp build/niao-ruby/bin/niao-ruby.wasm "$root/apps/ruby-runner/src/generated/"

cp build/niao-ruby/bin/niao-ruby.js "$root/apps/ruby-runner/src/generated/niao-ruby.js"
