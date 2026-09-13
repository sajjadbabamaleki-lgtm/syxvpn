# Builds the web app and serves the static bundle.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY vite.config.js index.html landing.html landing-en.html ./
COPY scripts ./scripts
COPY content ./content
COPY src ./src
COPY public ./public
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

# Where this deployment actually lives. The landing pages put it in their
# canonical, hreflang and Open Graph tags, so a wrong value here is a page that
# tells search engines to index somebody else's address.
ARG VITE_SITE_URL="https://syxvpn.pro"
ENV VITE_SITE_URL=$VITE_SITE_URL

# Where the Android build is published. Left empty, the download buttons point
# at nothing — set it to the real file before announcing the page.
ARG VITE_APK_URL="/download/syxvpn.apk"
ENV VITE_APK_URL=$VITE_APK_URL

RUN npm run build

# robots.txt and sitemap.xml carry absolute URLs, so they are generated here
# where the address is known rather than committed with a guess in them.
#
# The two indexable pages are / (English) and /fa (Persian). /en is a 301 to /,
# and the previous sitemap listed it as a page and named it as the English
# alternate — a sitemap of redirects, telling a crawler the canonical English
# address is one that immediately sends it somewhere else.
RUN node scripts/build-pages.mjs "$VITE_SITE_URL" dist

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
