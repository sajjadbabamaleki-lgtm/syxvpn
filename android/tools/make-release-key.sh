#!/bin/sh
# Create the one key that signs every cVPN release, for as long as the app exists.
#
# Android identifies an app by its signature, not by its name. An update signed
# with a different key is not an update: the installer refuses it, and the only
# way forward for the person holding the old version is to uninstall — losing
# their account, their configs and their subscription with it. There is no
# recovery, no appeal and no support ticket that fixes it. So this key is
# generated once, and then kept for years.
#
# Which is why this script is run by you, on a machine you own, and not by
# anything else. A signing key that has passed through someone else's process is
# a key somebody else may have.
#
#   sh android/tools/make-release-key.sh
#
# It writes the keystore, prints the four values GitHub Actions needs, and — if
# the GitHub CLI is here and signed in — offers to upload them itself.
set -eu

OUT=${OUT:-$HOME/cvpn-release}
STORE="$OUT/cvpn-release.jks"
ALIAS=${ALIAS:-cvpn}
# 10000 days: a little over 27 years. Google Play requires a certificate valid
# past 2033, and a key that expires is a key that ends the app.
VALIDITY=${VALIDITY:-10000}

command -v keytool >/dev/null 2>&1 || {
  echo "keytool is missing. It comes with a JDK:" >&2
  echo "    apt-get install -y default-jdk-headless" >&2
  exit 1
}

# Never silently. Overwriting this file is the same as losing it.
if [ -e "$STORE" ]; then
  echo "REFUSING: $STORE already exists." >&2
  echo "" >&2
  echo "If that is the real signing key, it is the one to keep — do not make" >&2
  echo "another. If you are certain it is not, move it aside by hand first." >&2
  exit 1
fi

mkdir -p "$OUT"
chmod 700 "$OUT"

# Generated, not chosen. This password is stored in a GitHub secret and typed by
# nobody, so it has no reason to be memorable and every reason to be long.
if command -v openssl >/dev/null 2>&1; then
  PASS=$(openssl rand -base64 33 | tr -d '\n=+/' | cut -c1-32)
else
  PASS=$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-32)
fi
[ ${#PASS} -ge 24 ] || { echo "could not generate a password" >&2; exit 1; }

# PKCS12 rather than the legacy JKS format, and so one password for both the
# store and the key: PKCS12 has only one, and keytool warns on every use of a
# keystore that pretends otherwise.
keytool -genkeypair \
  -keystore "$STORE" -storetype PKCS12 \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 \
  -validity "$VALIDITY" \
  -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=cVPN, O=cVPN" >/dev/null

chmod 600 "$STORE"
base64 < "$STORE" | tr -d '\n' > "$OUT/keystore.base64"
chmod 600 "$OUT/keystore.base64"

# The fingerprint of the certificate inside. This is not a secret — it is in
# every APK this key signs, and anyone can read it out of one. It is written
# down so that CI can refuse to publish an APK signed by anything else.
DIGEST=$(keytool -list -v -keystore "$STORE" -storepass "$PASS" -alias "$ALIAS" \
  | awk -F': ' '/SHA256:/ {print $2; exit}' | tr -d ' \r')

cat <<INFO

  The key is made. It is at:

      $STORE

  ---------------------------------------------------------------- back it up
  Copy that file somewhere off this machine, right now, before anything else.
  A password manager, an encrypted drive, anywhere that is not this server. If
  this machine dies and the key dies with it, every installed copy of the app
  is stranded on the version it already has, permanently.

  --------------------------------------------------------- the four secrets
  These go into the repository at:
    Settings -> Secrets and variables -> Actions -> New repository secret

    ANDROID_KEY_ALIAS          $ALIAS
    ANDROID_KEYSTORE_PASSWORD  $PASS
    ANDROID_KEY_PASSWORD       $PASS
    ANDROID_KEYSTORE_BASE64    the contents of
                               $OUT/keystore.base64
                               (long; paste it whole, with no line breaks)

  ----------------------------------------------------------- the fingerprint
  Put this in the repository as android/release-certificate.sha256, so a build
  signed with any other key fails instead of shipping:

    $DIGEST

INFO

# The base64 is several kilobytes. Pasting it by hand is miserable and easy to
# get subtly wrong, so hand it to the CLI if the CLI is here.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  printf '  The GitHub CLI is signed in here. Upload all four now? [y/N] '
  read -r reply
  case "$reply" in
    y|Y)
      gh secret set ANDROID_KEY_ALIAS --body "$ALIAS"
      gh secret set ANDROID_KEYSTORE_PASSWORD --body "$PASS"
      gh secret set ANDROID_KEY_PASSWORD --body "$PASS"
      gh secret set ANDROID_KEYSTORE_BASE64 < "$OUT/keystore.base64"
      echo "  Done. All four are set."
      ;;
    *) echo "  Left alone. The values are above." ;;
  esac
else
  cat <<'HINT'
  The GitHub CLI would upload these for you, which beats pasting a few
  kilobytes of base64 by hand:

      type -p curl >/dev/null || apt-get install -y curl
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
      echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
      apt-get update && apt-get install -y gh
      gh auth login

  Then run this script again — it will refuse to make a second key, so move
  the one it just made aside first, or set the secrets by hand from the values
  printed above.
HINT
fi
