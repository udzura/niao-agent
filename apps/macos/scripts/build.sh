#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
xcodebuild -project apps/macos/Niao.xcodeproj -scheme Niao \
  -configuration Debug -derivedDataPath apps/macos/build build "$@"
