# Gateway agent image: the agent plus the Xray binary it supervises.
#
# The agent needs to write the Xray configuration and manage the process, so it
# runs as root inside its own container. Deploy it on the gateway host only.
FROM node:22-bookworm-slim

# Debian here rather than Alpine: the agent image only needs curl/unzip to fetch
# the pinned Xray release, and the official builds target glibc.
ARG XRAY_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/* \
 && ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in \
      amd64) XRAY_ASSET=Xray-linux-64.zip ;; \
      arm64) XRAY_ASSET=Xray-linux-arm64-v8a.zip ;; \
      *) echo "unsupported architecture: $ARCH" >&2 && exit 1 ;; \
    esac \
 && if [ "$XRAY_VERSION" = "latest" ]; then \
      URL="https://github.com/XTLS/Xray-core/releases/latest/download/$XRAY_ASSET"; \
    else \
      URL="https://github.com/XTLS/Xray-core/releases/download/$XRAY_VERSION/$XRAY_ASSET"; \
    fi \
 && curl -fsSL -o /tmp/xray.zip "$URL" \
 && unzip -o /tmp/xray.zip -d /usr/local/share/xray xray geoip.dat geosite.dat \
 && install -m 0755 /usr/local/share/xray/xray /usr/local/bin/xray \
 && rm -f /tmp/xray.zip \
 && apt-get purge -y unzip && apt-get autoremove -y

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    XRAY_BIN=/usr/local/bin/xray \
    XRAY_LOCATION_ASSET=/usr/local/share/xray \
    STATE_DIR=/var/lib/jordan-agent \
    RELOAD_MODE=supervise
RUN mkdir -p /var/lib/jordan-agent

CMD ["node", "src/index.js"]
