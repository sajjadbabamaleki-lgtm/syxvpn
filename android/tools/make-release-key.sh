#!/bin/sh
# Create the one key that signs every SixVPN release, for as long as the app exists.
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

OUT=${OUT:-$HOME/sixvpn-release}
STORE="$OUT/sixvpn-release.jks"
ALIAS=${ALIAS:-sixvpn}
# 10000 days: a little over 27 years. Google Play requires a certificate valid
# past 2033, and a key that expires is a key that ends the app.
VALIDITY=${VALIDITY:-10000}

command -v keytool >/dev/null 2>&1 || {
  # The runtime, not the full JDK: keytool ships with the JRE, and nothing here
  # compiles anything.
  echo "keytool is missing. Install a Java runtime:" >&2
  echo "    apt-get update && apt-get install -y default-jre-headless" >&2
  echo "(on Fedora/RHEL: dnf install -y java-latest-openjdk-headless)" >&2
  exit 1
}

PASSFILE="$OUT/keystore-password.txt"

# Everything the four secrets and the fingerprint are read out of. Printing it
# once at the end is not enough: the last time this ran, the output scrolled off
# a phone terminal within minutes, and a keystore whose password is gone is a
# keystore that cannot sign anything.
report() {
  DIGEST=$(keytool -list -v -keystore "$STORE" -storepass "$PASS" -alias "$ALIAS" \
    | awk -F': ' '/SHA256:/ {print $2; exit}' | tr -d ' \r')
  [ -n "$DIGEST" ] || { echo "could not read the certificate out of $STORE" >&2; exit 1; }

  cat <<INFO

  ---------------------------------------------------------------- back it up
  The key is at:

      $STORE

  and its password is beside it, in:

      $PASSFILE

  Copy BOTH somewhere off this machine, now. The key without the password
  signs nothing. If this machine dies and they die with it, every installed
  copy of the app is stranded on the version it already has, permanently.

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
  Not a secret: it is in every APK this key signs. It goes in the repository
  as android/release-certificate.sha256, so a build signed with any other key
  fails instead of shipping.

    $DIGEST

INFO
}

# Never a second key, and never silently. Overwriting this file is the same as
# losing it: an app signed by a different key cannot update the one people have.
if [ -e "$STORE" ]; then
  if [ -r "$PASSFILE" ]; then
    # Not an error — somebody re-running this wants the numbers again, which is
    # the whole reason they are kept.
    echo "The key already exists. Nothing was changed; here it is again."
    PASS=$(cat "$PASSFILE")
    [ -f "$OUT/keystore.base64" ] || base64 < "$STORE" | tr -d '\n' > "$OUT/keystore.base64"
    chmod 600 "$OUT/keystore.base64"
    report
    # Falls through to the upload offer below: re-running this is usually
    # somebody who has just installed the GitHub CLI in order to use it.
    HAVE_KEY_ALREADY=yes
  else
    echo "REFUSING: $STORE already exists, and $PASSFILE does not." >&2
    echo "" >&2
    echo "Its password was printed when it was made — scroll back and find it." >&2
    echo "Without it the key cannot sign anything and cannot be read." >&2
    echo "" >&2
    echo "If it is truly gone AND no release has been published with this key" >&2
    echo "yet, then nothing depends on it and it is safe to start over:" >&2
    echo "" >&2
    echo "    rm -rf $OUT && sh \$0" >&2
    echo "" >&2
  echo "Once one person has installed an APK signed by it, that is no longer" >&2
    echo "true, and the key must be recovered rather than replaced." >&2
    exit 1
  fi
fi

if [ "${HAVE_KEY_ALREADY:-}" != yes ]; then

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
  -dname "CN=SixVPN, O=SixVPN" >/dev/null

chmod 600 "$STORE"
base64 < "$STORE" | tr -d '\n' > "$OUT/keystore.base64"
chmod 600 "$OUT/keystore.base64"

# The password, kept beside the key rather than only on the screen.
#
# It is one more secret on a machine that already holds the key itself, which
# is the thing worth stealing — so this gives away almost nothing. What it buys
# is the case that actually happens: a backup of the .jks alone is worthless
# without the password, and a password that exists only in terminal scrollback
# is a password that is already half lost.
printf '%s\n' "$PASS" > "$PASSFILE"
chmod 600 "$PASSFILE"

echo "  Key created."
report

fi

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

  Then run this script again. It will not make a second key — it prints these
  same values back and offers to upload them.
HINT
fi
