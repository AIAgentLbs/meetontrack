#!/bin/bash
# Run a release build step with the stable MeetOnTrack code signing identity.
#
# macOS ties Screen & System Audio Recording (and the other privacy grants) to
# the app's designated requirement. An ad-hoc signature makes that the cdhash,
# so every build was a new app and lost the permission (MEETONTRACK-155). One
# self-signed certificate, kept in Vault, gives every release the same
# requirement: capture/Packaging/designated-requirement.txt.
#
# The key never touches the repository or the login keychain: it goes into a
# throwaway keychain that is on the search list only while the command runs.
# Usage: scripts/with-signing-identity.sh scripts/assemble-arm64-app.sh
set -euo pipefail
[[ $# -gt 0 ]] || { echo "usage: $0 command [args...]" >&2; exit 2; }
# One signing build at a time per user: each run snapshots and restores the
# shared keychain search list, so two at once would drop each other's keychain.
if [[ -z "${MEETONTRACK_SIGNING_LOCKED:-}" ]]; then
  MEETONTRACK_SIGNING_LOCKED=1 exec /usr/bin/lockf -k "${TMPDIR:-/tmp}/meetontrack-signing-$(id -u).lock" "$0" "$@"
fi
ITEM="${MEETONTRACK_SIGNING_VAULT_ITEM:-MeetOnTrack macOS self-signed code signing}"
BW_SAFE="${BW_SAFE:-$HOME/.local/bin/bw-safe}"
work="$(mktemp -d "${TMPDIR:-/tmp}/meetontrack-signing.XXXXXX")"
keychain="$work/signing.keychain-db"
trap 'rm -rf "$work"' EXIT
security list-keychains -d user > "$work/search-list"  # fails before any secret is fetched
saved_list=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"; line="${line%\"}"; line="${line#\"}"
  [[ -n "$line" ]] && saved_list+=("$line")
done < "$work/search-list"
cleanup() {
  local status=$? attempt
  security delete-keychain "$keychain" 2>/dev/null || true
  for attempt in 1 2 3; do
    if security list-keychains -d user -s ${saved_list[@]+"${saved_list[@]}"} \
      && [[ "$(security list-keychains -d user)" == "$(cat "$work/search-list")" ]]; then
      rm -rf "$work"
      exit "$status"
    fi
    sleep 1
  done
  # Keep only the (non-secret) snapshot so the list can be put back by hand.
  find "$work" -mindepth 1 ! -name search-list -exec rm -rf {} +
  echo "Could not restore the keychain search list; the original is in $work/search-list" >&2
  exit 1
}
trap cleanup EXIT
build_umask="$(umask)"
umask 077
"$BW_SAFE" -- get item "$ITEM" > "$work/item.json"
python3 - "$work" <<'PY'
import base64, json, pathlib, sys
work = pathlib.Path(sys.argv[1])
item = json.loads((work / 'item.json').read_text())
fields = {field['name']: field['value'] for field in item['fields']}
(work / 'signing.p12').write_bytes(base64.b64decode(item['notes']))
(work / 'p12pass').write_text(fields['p12_password'])
(work / 'sha1').write_text(fields['certificate_sha1'].upper())
(work / 'item.json').unlink()
PY
sign_id="$(cat "$work/sha1")"
# Re-wrap with a one-time password so the stored one never appears in argv.
once="$(openssl rand -hex 24)"
# The decrypted key stays in memory; -export reads the key and the certificate separately.
pem="$(openssl pkcs12 -legacy -in "$work/signing.p12" -passin "file:$work/p12pass" -nodes 2>/dev/null)"
openssl pkcs12 -export -legacy -name "MeetOnTrack Code Signing" -passout "pass:$once" -out "$work/once.p12" \
  -inkey <(printf '%s\n' "$pem") -in <(printf '%s\n' "$pem")
unset pem
rm -f "$work/signing.p12" "$work/p12pass"
security create-keychain -p "$once" "$keychain"
security set-keychain-settings "$keychain"  # no auto-lock during a long build
security unlock-keychain -p "$once" "$keychain"
security import "$work/once.p12" -k "$keychain" -f pkcs12 -P "$once" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$once" "$keychain" >/dev/null
rm -f "$work/once.p12"
# codesign finds an identity only in a keychain on the search list.
security list-keychains -d user -s ${saved_list[@]+"${saved_list[@]}"} "$keychain"
security find-identity -p codesigning "$keychain" | grep -q "$sign_id" \
  || { echo "Signing identity $sign_id missing after import" >&2; exit 1; }
# The build itself keeps the caller's umask; 077 is only for the key material.
umask "$build_umask"
MEETONTRACK_SIGN_ID="$sign_id" MEETONTRACK_SIGN_KEYCHAIN="$keychain" "$@"
