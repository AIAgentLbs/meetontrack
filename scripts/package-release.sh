#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/capture/.build/MeetingCopilotCapture.app}"
OUT="${2:-$ROOT/dist/meeting-copilot-macos.zip}"
PYTHON_RUNTIME="${MEETING_COPILOT_PYTHON_RUNTIME:-}"
[[ -d "$APP" ]] || { echo "Missing app: $APP" >&2; exit 1; }
[[ -x "$PYTHON_RUNTIME/bin/python3" ]] || { echo 'Set MEETING_COPILOT_PYTHON_RUNTIME to a clean relocatable arm64 Python 3.12+ distribution (numpy 2.5.4 wheels)' >&2; exit 1; }
"$PYTHON_RUNTIME/bin/python3" -I -c 'import platform, sys; assert platform.machine() == "arm64" and sys.version_info >= (3, 12)'
REQUIREMENT="$ROOT/capture/Packaging/designated-requirement.txt"
[[ -n "${MEETONTRACK_SIGN_ID:-}" && -n "${MEETONTRACK_SIGN_KEYCHAIN:-}" ]] \
  || { echo "Run through scripts/with-signing-identity.sh (MEETONTRACK-155)" >&2; exit 1; }
sign() { codesign --force --sign "$MEETONTRACK_SIGN_ID" --keychain "$MEETONTRACK_SIGN_KEYCHAIN" --timestamp=none "$@"; }
stage="$(mktemp -d "${TMPDIR:-/tmp}/meeting-copilot-release.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
bundle="$stage/Meeting Copilot Capture.app"
cp -R "$APP" "$bundle"
# One app: the Python runtime, web service, helpers and config templates live
# inside the bundle, which starts the service itself (MEETONTRACK-109).
payload="$bundle/Contents/Resources/payload"
mkdir -p "$payload"
# Copy the runtime's contents: a runtime path that is itself a symlink (uv's
# managed Pythons are) must not end up as a link to, and be modified at, the source.
mkdir -p "$payload/python"
cp -R "$PYTHON_RUNTIME/." "$payload/python"
# Visual speaker names need numpy and Pillow; without them every frame silently
# had no speaker. Install them into the bundled runtime.
uv pip install --python "$payload/python/bin/python3" --break-system-packages \
  --require-hashes --only-binary :all: -r "$ROOT/scripts/image-requirements.txt"
"$payload/python/bin/python3" -I -B -c 'import numpy, PIL.Image'
cp -R "$ROOT/copilot/web" "$payload/web"
python3 "$ROOT/scripts/vendor-delivery.py" "$payload/web/_vendor"
# Some wheels (pyasn1 0.6.5, oauthlib) unpack 0600; ship the usual modes.
chmod -R go+rX "$payload/web/_vendor"
mkdir -p "$payload/bin"
cp "$ROOT/copilot/bin/meeting-copilot" "$payload/bin/meeting-copilot"
swiftc "$ROOT/copilot/bin/ZoomWindowFinder.swift" -o "$payload/bin/zoom-window-finder"
swiftc "$ROOT/copilot/bin/ZoomFrameInspector.swift" -o "$payload/bin/zoom-frame-inspector"
swiftc "$ROOT/copilot/bin/DetectSpeechLanguage.swift" -o "$payload/bin/detect-speech-language"
for helper in zoom-window-finder zoom-frame-inspector detect-speech-language; do
  sign "$payload/bin/$helper"
done
cp -R "$ROOT/copilot/config" "$payload/config"
find "$stage" -name '__pycache__' -type d -prune -exec rm -rf {} +
# Adding the payload changed the bundle: seal it again (nested code keeps its
# own signatures). Same identity, requirement and entitlements as assemble-arm64-app.sh.
sign --identifier com.aiagentlbs.meetingcopilot.capture --requirements "$REQUIREMENT" \
  --entitlements "$ROOT/capture/Packaging/MeetingCopilot.entitlements" "$bundle"
codesign --verify --strict --verbose=2 "$bundle"
codesign --verify -R "=$(sed -e 's/^designated => //' "$REQUIREMENT")" "$bundle"
python3 - "$stage" "$(git -C "$ROOT" rev-parse HEAD)" <<'PY'
import hashlib, json, os, pathlib, plistlib, sys
root = pathlib.Path(sys.argv[1])
info = plistlib.loads((root / "Meeting Copilot Capture.app/Contents/Info.plist").read_bytes())
files = {}
for path in sorted(root.rglob("*")):
    if path.is_symlink():
        # zip -y stores the link itself, not the bytes it points to. Include
        # framework directory links as well as links to regular files.
        files[str(path.relative_to(root))] = hashlib.sha256(os.readlink(path).encode()).hexdigest()
        continue
    if path.is_file():
        relative = str(path.relative_to(root))
        if path.suffix in {".caf", ".wav", ".log"} or path.name in {"meeting.json", "report.json", "delivery.json", "frames.json", "repos.json", "active-repos.json"}:
            raise SystemExit(f"Private runtime data must not enter a release: {relative}")
        files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
manifest = {"version": info["CFBundleShortVersionString"], "source_revision": sys.argv[2],
            "architecture": "arm64", "channel": "technical-beta", "notarized": False,
            "automatic_updates": bool(info.get("SUEnableAutomaticChecks", False)), "sha256": files}
(root / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")
PY
mkdir -p "$(dirname "$OUT")"
[[ ! -e "$OUT" ]] || { echo "Refusing to overwrite an existing release: $OUT" >&2; exit 1; }
(cd "$stage" && /usr/bin/zip -qry "$OUT" .)
echo "$OUT"
