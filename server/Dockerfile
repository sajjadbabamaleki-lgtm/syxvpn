# Control plane image.
#
# better-sqlite3 v13 ships prebuilt binaries for musl and glibc alike, so Alpine
# needs no C toolchain here. Installing with --ignore-scripts keeps it that way:
# npm would otherwise fall back to `node-gyp rebuild` for any package carrying a
# binding.gyp, and it stops dependency install scripts from running in the build.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# The database lives on a volume; the process itself needs no write access to /app.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/readiness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
