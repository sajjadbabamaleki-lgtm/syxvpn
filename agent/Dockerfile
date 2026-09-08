FROM node:22-alpine
RUN apk add --no-cache ca-certificates unzip curl \
 && ARCH=$(uname -m) \
 && case "$ARCH" in \
      x86_64) XRAY_ASSET=Xray-linux-64.zip ;; \
      aarch64) XRAY_ASSET=Xray-linux-arm64-v8a.zip ;; \
      *) echo "unsupported architecture: $ARCH" && exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/latest/download/${XRAY_ASSET}" \
 && unzip -o /tmp/xray.zip -d /usr/local/share/xray xray geoip.dat geosite.dat \
 && install -m 0755 /usr/local/share/xray/xray /usr/local/bin/xray \
 && rm -f /tmp/xray.zip
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV STATE_DIR=/var/lib/jordan-agent \
    XRAY_BIN=/usr/local/bin/xray \
    RELOAD_MODE=supervise \
    XRAY_LOCATION_ASSET=/usr/local/share/xray
RUN mkdir -p /var/lib/jordan-agent
CMD ["node", "src/index.js"]
