#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CAPTURE="$ROOT/capture"
APP="$CAPTURE/.build/MeetingCopilotCapture.app"
DONOR="${MEETING_COPILOT_RUNTIME_DONOR:-/Applications/Meeting Copilot Capture.app}"
BUILD_ROOT="${MEETING_COPILOT_BUILD_ROOT:-$CAPTURE/.build}"
BIN="$BUILD_ROOT/arm64-apple-macosx/release/meetingcopilot"
VERSION="${MEETING_COPILOT_VERSION:-0.1.38}"
BUILD="${MEETING_COPILOT_BUILD:-$(git -C "$ROOT" rev-list --count HEAD)}"
SPARKLE="$(find "$BUILD_ROOT/artifacts/sparkle" -type d -name Sparkle.framework -path '*macos-arm64_x86_64*' | head -1)"
[[ -x "$BIN" ]] || { echo "Run swift build -c release first" >&2; exit 1; }
REQUIREMENT="$CAPTURE/Packaging/designated-requirement.txt"
# A stable signature keeps the privacy grants across updates (MEETONTRACK-155).
[[ -n "${MEETONTRACK_SIGN_ID:-}" && -n "${MEETONTRACK_SIGN_KEYCHAIN:-}" ]] \
  || { echo "Run through scripts/with-signing-identity.sh" >&2; exit 1; }
grep -qi "H\"$MEETONTRACK_SIGN_ID\"" "$REQUIREMENT" \
  || { echo "Identity $MEETONTRACK_SIGN_ID is not the one in $REQUIREMENT" >&2; exit 1; }
sign() { codesign --force --sign "$MEETONTRACK_SIGN_ID" --keychain "$MEETONTRACK_SIGN_KEYCHAIN" --timestamp=none "$@"; }
[[ -d "$DONOR" ]] || { echo "A LocalVQE runtime donor app is required" >&2; exit 1; }
make -C "$CAPTURE" icon
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Models" "$APP/Contents/Resources/Licenses" "$APP/Contents/Frameworks"
cp "$BIN" "$APP/Contents/MacOS/MeetingCopilotCapture"
sed -e "s/__SHORT_VERSION__/$VERSION/" -e "s/__BUILD_VERSION__/$BUILD/" "$CAPTURE/Packaging/MeetingCopilot-Info.plist" > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp "$CAPTURE/Resources/MeetingCopilot.icns" "$APP/Contents/Resources/MeetOnTrack.icns"
cp "$CAPTURE/LICENSE" "$APP/Contents/Resources/LICENSE"
cp "$CAPTURE/THIRD-PARTY-NOTICES.md" "$APP/Contents/Resources/"
cp "$DONOR/Contents/Frameworks/liblocalvqe.dylib" "$APP/Contents/Frameworks/"
cp "$DONOR/Contents/Resources/Models/localvqe-v1.4-aec-200K-f32.gguf" "$APP/Contents/Resources/Models/"
cp "$DONOR/Contents/Resources/LocalVQE-verification.json" "$APP/Contents/Resources/"
cp -R "$DONOR/Contents/Resources/Licenses/." "$APP/Contents/Resources/Licenses/"
cp -R "$SPARKLE" "$APP/Contents/Frameworks/"
rm -rf "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices"
# Innermost first: signing a container after its contents keeps both seals valid.
for nested in "$APP/Contents/Frameworks/liblocalvqe.dylib" \
  "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate" \
  "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app" \
  "$APP/Contents/Frameworks/Sparkle.framework"; do
  sign "$nested"
done
sign --identifier com.aiagentlbs.meetingcopilot.capture --requirements "$REQUIREMENT" \
  --entitlements "$CAPTURE/Packaging/MeetingCopilot.entitlements" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign --verify -R "=$(sed -e 's/^designated => //' "$REQUIREMENT")" "$APP"
echo "$APP"
