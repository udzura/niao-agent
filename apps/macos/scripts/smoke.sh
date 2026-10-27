#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p apps/macos/build
swiftc -parse-as-library apps/macos/Niao/Models.swift apps/macos/Niao/Backend.swift \
  apps/macos/Smoke/SmokeMain.swift -o apps/macos/build/niao-smoke
apps/macos/build/niao-smoke "$@"
