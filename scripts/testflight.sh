#!/usr/bin/env bash
# Archive → export → upload the Expo app to TestFlight, using an App Store
# Connect API key (no interactive Apple ID / 2FA needed).
#
# The predecessor of this script, which shipped the SwiftUI app, is
# scripts/legacy-testflight.sh. Use the resolved Expo bundle id intentionally:
# upstream and personal fork flavors may target different App Store records.
#
# Prereqs:
#   - Full Xcode, ASC API key at ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8
#   - An App Store Connect app record for the resolved Expo bundle id
#
# Usage:
#   APPLE_TEAM_ID=<team> ASC_KEY_ID=<key> ASC_ISSUER_ID=<uuid> scripts/testflight.sh
#   ... scripts/testflight.sh --no-upload   # stop at the .ipa
#
# From a background session (SSH, launchd), where the login keychain cannot be
# unlocked and codesign fails with errSecInternalComponent, sign from a keychain
# whose password is on disk instead:
#   SIGNING_KEYCHAIN=~/Library/Keychains/x.keychain-db SIGNING_KEYCHAIN_PASSWORD_FILE=~/.x/.kcpass \
#   ASC_SIGNING_CERT=<sha1 of a distribution cert in it> ASC_PROFILE_NAME=<App Store profile holding it> \
#   ... scripts/testflight.sh
# The archive is then signed for distribution directly (manual signing on the
# app target only), since no development identity lives in that keychain.
#
# See RELEASING.md.
#
# NOTE: TestFlight rate-limits uploads per app per day (altool 90382). Bump the
# build number on every change so commits stay honest, but batch the uploads.
set -euo pipefail

cd "$(dirname "$0")/.."

# Account-specific, so they come from the environment. A fork must not silently
# try to sign against someone else's Apple team.
TEAM_ID="${APPLE_TEAM_ID:?set APPLE_TEAM_ID (Apple Developer > Membership)}"
KEY_ID="${ASC_KEY_ID:?set ASC_KEY_ID (App Store Connect API key id)}"
PROFILE_NAME_ENV="${ASC_PROFILE_NAME:-}"
# The SHA-1 of the certificate the profile above was issued against, NOT the
# display name.
#
# "Apple Distribution" is not unique: a team accumulates several, all with the
# same subject line, and the keychain search order decides which one `security`
# hands over first. A second one signed for an unrelated app shadowed this one
# and export died with "Provisioning profile doesn't include signing
# certificate" after a fifteen-minute archive that was otherwise fine. A hash
# cannot be shadowed.
#
SIGNING_CERT="${ASC_SIGNING_CERT:-}"
KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
BUILD_DIR="build"
CONFIG_JSON="$BUILD_DIR/expo-config.json"
EXPORT_DIR="$BUILD_DIR/export"
PLIST="$BUILD_DIR/ExportOptions.plist"

if [[ -z "${ASC_ISSUER_ID:-}" ]]; then
  echo "ERROR: set ASC_ISSUER_ID (App Store Connect > Users and Access > Integrations)." >&2
  exit 1
fi
if [[ ! -f "$KEY_PATH" ]]; then
  echo "ERROR: API key not found at $KEY_PATH" >&2
  exit 1
fi
if [[ -z "$SIGNING_CERT" ]]; then
  echo "ERROR: set ASC_SIGNING_CERT to the SHA-1 of the Apple Distribution certificate in the provisioning profile." >&2
  exit 1
fi

if [[ -n "${SIGNING_KEYCHAIN:-}" ]]; then
  if [[ ! -f "$SIGNING_KEYCHAIN" ]]; then
    echo "ERROR: no keychain at $SIGNING_KEYCHAIN" >&2
    exit 1
  fi
  if [[ -n "${SIGNING_KEYCHAIN_PASSWORD_FILE:-}" ]]; then
    security unlock-keychain -p "$(cat "$SIGNING_KEYCHAIN_PASSWORD_FILE")" "$SIGNING_KEYCHAIN"
  fi
  # Xcode resolves identities through the search list. `grep -c`, not `-q`:
  # see the pipefail note further down.
  if [ "$(security list-keychains -d user | grep -cF "$SIGNING_KEYCHAIN")" -eq 0 ]; then
    # shellcheck disable=SC2046
    security list-keychains -d user -s "$SIGNING_KEYCHAIN" $(security list-keychains -d user | tr -d '"')
  fi
  if [ "$(security find-identity -v -p codesigning "$SIGNING_KEYCHAIN" | grep -cF "$SIGNING_CERT")" -eq 0 ]; then
    echo "ERROR: $SIGNING_CERT is not a signing identity in $SIGNING_KEYCHAIN." >&2
    exit 1
  fi
fi

AUTH=(-allowProvisioningUpdates
      -authenticationKeyPath "$KEY_PATH"
      -authenticationKeyID "$KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID")

mkdir -p "$BUILD_DIR"
npx expo config --json > "$CONFIG_JSON"
read_config() {
  node -e '
const config = require(require("path").resolve(process.argv[1]));
const path = process.argv[2].split(".");
let value = config;
for (const key of path) value = value == null ? undefined : value[key];
if (Array.isArray(value)) value = value[0];
if (value == null || value === "") process.exit(1);
process.stdout.write(String(value));
' "$CONFIG_JSON" "$1"
}

APP_NAME="$(read_config name)"
APP_SLUG="$(read_config slug)"
BUNDLE_ID="$(read_config ios.bundleIdentifier)"
VERSION="$(read_config version)"
BUILD_NUMBER="$(read_config ios.buildNumber)"
PROFILE_NAME="${PROFILE_NAME_ENV:-${APP_NAME} App Store}"
ARCHIVE="$BUILD_DIR/${APP_SLUG}.xcarchive"
IPA="$EXPORT_DIR/${APP_SLUG}.ipa"

# Resume path for the case where the archive succeeded and a later step did not.
# The archive is the fifteen-minute part; export and upload are seconds. Signing
# and profile problems surface at EXPORT, so without this every attempt to fix
# one pays for a rebuild that already worked.
if [[ -n "${SKIP_ARCHIVE:-}" ]]; then
  if [[ ! -d "$ARCHIVE" ]]; then
    echo "ERROR: SKIP_ARCHIVE set but no archive at $ARCHIVE" >&2
    exit 1
  fi
  HAVE=$(plutil -extract ApplicationProperties.CFBundleVersion raw -o - "$ARCHIVE/Info.plist" 2>/dev/null || echo '?')
  if [[ "$HAVE" != "$BUILD_NUMBER" ]]; then
    echo "ERROR: archive is build $HAVE, resolved Expo config says $BUILD_NUMBER. Re-archive." >&2
    exit 1
  fi
  echo "==> Reusing archive at $ARCHIVE ($VERSION build $HAVE)"
  rm -rf "$EXPORT_DIR"
else

# ios/ is generated, so regenerate it rather than trusting whatever is on disk.
# This is also what applies any Expo config change since the last run.
echo "==> Prebuilding ios/ from resolved Expo config ($APP_NAME, $BUNDLE_ID, $VERSION build $BUILD_NUMBER)…"
npx expo prebuild --platform ios --clean

WORKSPACE="$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)"
if [[ -z "$WORKSPACE" ]]; then
  echo "ERROR: Expo prebuild did not generate an iOS workspace." >&2
  exit 1
fi
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
PROJECT="ios/${SCHEME}.xcodeproj"
python3 scripts/check_ios_scene.py "ios/$SCHEME/Info.plist"

rm -rf "$ARCHIVE" "$EXPORT_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Archiving $SCHEME (Release)…"
if [[ -n "${SIGNING_KEYCHAIN:-}" ]]; then
  # Manual distribution signing on the app target alone: set on the command
  # line it would reach every Pods target too. ios/ is regenerated above, so
  # this edits a build product, not the project's configuration.
  GEM_HOME="$(brew --prefix cocoapods)/libexec" ruby -rxcodeproj -e '
    project = Xcodeproj::Project.open(ARGV[0])
    target = project.targets.find { |t| t.name == ARGV[1] } or abort("no target #{ARGV[1]}")
    target.build_configurations.select { |c| c.name == "Release" }.each do |c|
      c.build_settings.merge!(
        "CODE_SIGN_STYLE" => "Manual", "CODE_SIGN_IDENTITY" => ARGV[2],
        "PROVISIONING_PROFILE_SPECIFIER" => ARGV[3], "DEVELOPMENT_TEAM" => ARGV[4],
        "OTHER_CODE_SIGN_FLAGS" => "--keychain #{ARGV[5]}")
    end
    project.save' "$PROJECT" "$SCHEME" "$SIGNING_CERT" "$PROFILE_NAME" "$TEAM_ID" "$SIGNING_KEYCHAIN"
  xcodebuild archive \
    -workspace "$WORKSPACE" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" \
    COMPILER_INDEX_STORE_ENABLE=NO
else
  xcodebuild archive \
    -workspace "$WORKSPACE" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    CODE_SIGN_STYLE=Automatic \
    COMPILER_INDEX_STORE_ENABLE=NO \
    "${AUTH[@]}"
fi

fi

# MANUAL signing, not cloud. Some ASC keys can archive with
# `-allowProvisioningUpdates` but cannot perform cloud signing during
# `-exportArchive`, which fails with "Cloud signing permission error / No
# profiles were found" even though the archive signed fine. Naming the local
# distribution certificate and selected App Store profile sidesteps that cloud
# path entirely.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>app-store-connect</string>
    <key>teamID</key><string>${TEAM_ID}</string>
    <key>signingStyle</key><string>manual</string>
    <key>signingCertificate</key><string>${SIGNING_CERT}</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>${BUNDLE_ID}</key><string>${PROFILE_NAME}</string>
    </dict>
    <key>destination</key><string>export</string>
    <key>uploadSymbols</key><true/>
    <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF

echo "==> Exporting signed .ipa…"
# No auth key here: passing it re-engages the cloud-signing path the manual
# ExportOptions above exists to avoid.
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$PLIST"

# Xcode names the IPA after the native product, which can differ from Expo's
# slug. Normalize the single exported app before validation and upload.
shopt -s nullglob
EXPORTED_IPAS=("$EXPORT_DIR"/*.ipa)
shopt -u nullglob
if [[ "${#EXPORTED_IPAS[@]}" -ne 1 ]]; then
  echo "ERROR: expected one exported IPA in $EXPORT_DIR." >&2
  exit 1
fi
if [[ "${EXPORTED_IPAS[0]}" != "$IPA" ]]; then
  mv "${EXPORTED_IPAS[0]}" "$IPA"
fi

echo "==> Built: $IPA"
ls -lh "$IPA"

# The dev launcher must not be in a TestFlight build: it would put a server
# picker in front of the app on a tester's phone. Expo disables it in Release,
# and this is the guard that proves it did — the same class of check the legacy
# script ran for aps-environment.
echo "==> Verifying the dev launcher is not embedded…"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q -o "$IPA" -d "$WORK"
APP="$(/bin/ls -d "$WORK"/Payload/*.app | head -1)"
python3 scripts/check_ios_scene.py "$APP/Info.plist"
codesign --verify --deep --strict "$APP"
codesign -d --entitlements :- "$APP" > "$WORK/Entitlements.plist" 2>/dev/null
EXPECTED_APS="$(read_config ios.entitlements.aps-environment || true)"
BUILT_APS="$(/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$WORK/Entitlements.plist" 2>/dev/null || true)"
if [[ -n "$EXPECTED_APS" && "$BUILT_APS" != "$EXPECTED_APS" ]]; then
  echo "ERROR: built push entitlement '$BUILT_APS', expected '$EXPECTED_APS'. Re-archive with signing enabled." >&2
  exit 1
fi
if [[ -d "$APP/EXDevLauncher.bundle" ]]; then
  echo "ERROR: EXDevLauncher.bundle is inside the .ipa — this is not a release build." >&2
  exit 1
fi
# The SSH module is the app: without it there is no transport and every screen
# is an error state. Autolinking is silent when it doesn't happen, so prove the
# native side AND the JS side both made it in. (Hermes bytecode keeps its string
# table as one blob, so this must be a substring search, not a line match.)
#
# The needle is the registered CLASS name, not a message. An earlier version of
# this check looked for an error string from the host-key path and started
# failing on a clean build — the Swift optimiser is free to fold a literal that
# only appears in one error branch, so a message is not an invariant. The class
# name is: `expo-module.config.json` names it, and the module cannot resolve at
# runtime without it.
# `grep -c`, not `grep -q`. Under `set -o pipefail`, `grep -q` exits the moment
# it matches, `strings` then dies of SIGPIPE, and the pipeline reports 141 — so
# `if ! ...` fires exactly when the string WAS found. That inverted guard failed
# two good builds before the cause was spotted. `-c` consumes all input.
EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
if [ "$(strings -a "$APP/$EXECUTABLE_NAME" | grep -cF "HerdrSshModule")" -eq 0 ]; then
  echo "ERROR: the native SSH module is not in the binary." >&2
  exit 1
fi
if [ "$(strings -a "$APP/main.jsbundle" | grep -cF "HerdrSsh")" -eq 0 ]; then
  echo "ERROR: the JS bundle never references the HerdrSsh module." >&2
  exit 1
fi

BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist")"
BUILT_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Info.plist")"
BUILT_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
if [[ "$BUILT_BUNDLE_ID" != "$BUNDLE_ID" ]]; then
  echo "ERROR: built bundle $BUILT_BUNDLE_ID, expected $BUNDLE_ID." >&2
  exit 1
fi
if [[ "$BUILT_VERSION" != "$VERSION" || "$BUILT_BUILD" != "$BUILD_NUMBER" ]]; then
  echo "ERROR: built $BUILT_VERSION($BUILT_BUILD), expected $VERSION($BUILD_NUMBER)." >&2
  echo "       resolved Expo config and the archive disagree — prebuild probably didn't run." >&2
  exit 1
fi
echo "   ✓ release build, $BUILT_VERSION ($BUILT_BUILD)"

if [[ "${1:-}" == "--no-upload" ]]; then
  echo "==> --no-upload set; skipping the TestFlight upload."
  exit 0
fi

echo "==> Validating with App Store Connect…"
xcrun altool --validate-app -f "$IPA" -t ios \
  --apiKey "$KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "==> Uploading to TestFlight…"
xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "==> Done. The build appears in App Store Connect → TestFlight in a few minutes."
