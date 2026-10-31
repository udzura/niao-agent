#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
xcodebuild -project apps/ios/Niao.xcodeproj -scheme Niao \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath apps/ios/build CODE_SIGN_IDENTITY=- build "$@"
