#!/usr/bin/env sh
#
# Downloads the pinned Xray release into lab/bin/ so the lab images can be built
# without network access inside the build. Run once; the files are gitignored.
set -eu
cd "$(dirname "$0")"

XRAY_VERSION="${XRAY_VERSION:-latest}"
BIN_DIR="bin"

if [ -x "$BIN_DIR/xray" ]; then
  echo "xray already present in $BIN_DIR ($($BIN_DIR/xray version | head -1))"
  exit 0
fi

case "$(uname -m)" in
  x86_64) ASSET=Xray-linux-64.zip ;;
  aarch64|arm64) ASSET=Xray-linux-arm64-v8a.zip ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ "$XRAY_VERSION" = "latest" ]; then
  URL="https://github.com/XTLS/Xray-core/releases/latest/download/$ASSET"
else
  URL="https://github.com/XTLS/Xray-core/releases/download/$XRAY_VERSION/$ASSET"
fi

mkdir -p "$BIN_DIR"
echo "· downloading $URL"
curl -fsSL -o "$BIN_DIR/xray.zip" "$URL"
unzip -o "$BIN_DIR/xray.zip" -d "$BIN_DIR" xray geoip.dat geosite.dat >/dev/null
chmod +x "$BIN_DIR/xray"
rm -f "$BIN_DIR/xray.zip"
echo "· $($BIN_DIR/xray version | head -1)"
