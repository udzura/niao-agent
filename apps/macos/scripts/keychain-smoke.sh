#!/usr/bin/env bash
# Run after build:macos. Uses synthetic items; never reads the user's backend token.
set -euo pipefail
cd "$(dirname "$0")/../../.."
app=apps/macos/build/Build/Products/Debug/Niao.app
if [[ ! -f "$app/Contents/embedded.provisionprofile" ]]; then
  echo 'Build the Mac app with a development Team and provisioning profile first.' >&2
  exit 1
fi
work=$(mktemp -d /tmp/niao-keychain-smoke.XXXXXX)
trap 'rm -rf "$work"' EXIT
bundle="$work/NiaoKeychainSmoke.app"
mkdir -p "$bundle/Contents/MacOS"
cp "$app/Contents/embedded.provisionprofile" "$bundle/Contents/"
cp "$app/Contents/Info.plist" "$bundle/Contents/"
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable NiaoKeychainSmoke' "$bundle/Contents/Info.plist"
codesign -d --entitlements :- "$app" > "$work/entitlements.plist" 2>/dev/null
swiftc -parse-as-library -module-cache-path /tmp/niao-swift-modules \
  apps/macos/Niao/{Models,CredentialSession,CredentialMigration,Keychain}.swift \
  apps/macos/Smoke/KeychainSmoke.swift -o "$bundle/Contents/MacOS/NiaoKeychainSmoke"
codesign --force --sign "${NIAO_SIGNING_IDENTITY:-Apple Development}" \
  --entitlements "$work/entitlements.plist" --timestamp=none "$bundle"
"$bundle/Contents/MacOS/NiaoKeychainSmoke"
