# Builds the web app and serves the static bundle.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY vite.config.js index.html landing.html landing-en.html ./
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

# robots.txt and sitemap.xml carry absolute URLs, so they are written here where
# the address is known rather than committed with a guess in them.
RUN printf 'User-agent: *\nAllow: /\nAllow: /en\nDisallow: /app\n\nSitemap: %s/sitemap.xml\n' "$VITE_SITE_URL" > dist/robots.txt \
 && printf '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n  <url><loc>%s/</loc>\n    <xhtml:link rel="alternate" hreflang="fa" href="%s/"/>\n    <xhtml:link rel="alternate" hreflang="en" href="%s/en"/>\n  </url>\n  <url><loc>%s/en</loc>\n    <xhtml:link rel="alternate" hreflang="fa" href="%s/"/>\n    <xhtml:link rel="alternate" hreflang="en" href="%s/en"/>\n  </url>\n</urlset>\n' "$VITE_SITE_URL" "$VITE_SITE_URL" "$VITE_SITE_URL" "$VITE_SITE_URL" "$VITE_SITE_URL" "$VITE_SITE_URL" > dist/sitemap.xml

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
