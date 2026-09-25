#!/bin/bash
# Install only on an explicitly selected, connected iPad. Never select an iPhone.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${1:-}" == "--help" || -z "${1:-}" ]]; then
  echo 'Usage: bash scripts/install-one-club-ipad.sh IPAD_UDID'
  echo 'Unlock the iPad, trust this Mac, and enable Developer Mode before installation.'
  exit 0
fi
IPAD_UDID="$1"
DEVICE_JSON="$(mktemp -t one-club-ipad)"
trap 'rm -f "$DEVICE_JSON"' EXIT
xcrun devicectl device info details --device "$IPAD_UDID" --json-output "$DEVICE_JSON" >/dev/null
python3 - "$DEVICE_JSON" <<'PY'
import json, sys
v=json.load(open(sys.argv[1]))['result']
d=v.get('device',v)
h=d.get('hardwareProperties',{})
p=d.get('deviceProperties',{})
if h.get('deviceType') != 'iPad' and not h.get('productType','').startswith('iPad'):
    raise SystemExit('The selected device is not a verified iPad. Installation stopped.')
if p.get('developerModeStatus') != 'enabled':
    raise SystemExit('Enable Developer Mode on the selected iPad, unlock it, and run again.')
print('Verified target: iPad with Developer Mode enabled.')
PY
cd "$ROOT_DIR"
node scripts/build-ipad-runtime.mjs
xcodegen generate --spec apps/ipad/project.yml
SIGNING_AUTH=()
if [[ -n "${ONECLUB_ASC_KEY_PATH:-}" ]]; then
  : "${ONECLUB_ASC_KEY_ID:?Set ONECLUB_ASC_KEY_ID with the signing API key ID}"
  : "${ONECLUB_ASC_ISSUER_ID:?Set ONECLUB_ASC_ISSUER_ID with the signing API issuer}"
  [[ -r "$ONECLUB_ASC_KEY_PATH" ]] || { echo 'The configured signing API key file is not readable.' >&2; exit 1; }
  SIGNING_AUTH=(-authenticationKeyPath "$ONECLUB_ASC_KEY_PATH" -authenticationKeyID "$ONECLUB_ASC_KEY_ID" -authenticationKeyIssuerID "$ONECLUB_ASC_ISSUER_ID")
fi
xcodebuild -project apps/ipad/OneClubPOS.xcodeproj -scheme OneClubPOS -configuration Release \
  -destination "id=$IPAD_UDID" -derivedDataPath .storage/one-club-ipad-install \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  "${SIGNING_AUTH[@]}" \
  DEVELOPMENT_TEAM="${ONECLUB_APPLE_TEAM:-745ZPGFRA5}" build
APP_PATH="$ROOT_DIR/.storage/one-club-ipad-install/Build/Products/Release-iphoneos/OneClubPOS.app"
codesign --verify --deep --strict "$APP_PATH"
xcrun devicectl device install app --device "$IPAD_UDID" "$APP_PATH"
xcrun devicectl device process launch --device "$IPAD_UDID" com.blacklabel.oneclub.pos
echo 'Installed and launch requested. Verify the on-device register and saved venue data on the iPad.'
