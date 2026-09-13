/**
 * The pages Vite does not build: the articles, robots.txt and sitemap.xml.
 *
 * All three need the site's absolute address, which is only known at deploy
 * time, so they are written here rather than committed with a guess in them.
 * Run after `vite build`, against the same dist:
 *
 *     node scripts/build-pages.mjs https://syxvpn.pro dist
 *
 * Articles are markdown with a front-matter block, one file per language,
 * named `<slug>.<lang>.md`. A slug with only one language is published in that
 * language alone and simply has no alternate — better than a half-translated
 * page telling a crawler the two are the same document.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [, , SITE_ARG, DIST_ARG] = process.argv;
const SITE = (SITE_ARG || 'https://syxvpn.pro').replace(/\/+$/, '');
const DIST = join(ROOT, DIST_ARG || 'dist');

/** Where each language's pages live. Persian is under /fa, English at the root. */
const LANGS = {
  en: { dir: 'articles', home: '/', dirAttr: 'ltr', locale: 'en_US' },
  fa: { dir: 'fa/articles', home: '/fa', dirAttr: 'rtl', locale: 'fa_IR' },
};

const WORDS = {
  en: {
    index: 'Articles',
    lede: 'How this is built, what actually goes wrong, and how to tell one fault from another.',
    home: 'SyxVPN',
    back: 'All articles',
    updated: 'Updated',
    other: 'فارسی',
    otherLang: 'fa',
  },
  fa: {
    index: 'مقاله‌ها',
    lede: 'این چیز چطور ساخته شده، واقعاً چه چیزی خراب می‌شود، و چطور یک خرابی را از دیگری تشخیص بدهیم.',
    home: 'SyxVPN',
    back: 'همه مقاله‌ها',
    updated: 'به‌روزرسانی',
    other: 'English',
    otherLang: 'en',
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Front matter, then body. Values are plain strings; nothing here needs YAML. */
function parse(raw) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('article has no front matter');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: m[2] };
}

function readArticles() {
  const dir = join(ROOT, 'content/articles');
  const bySlug = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const m = /^(.+)\.(en|fa)\.md$/.exec(file);
    if (!m) throw new Error(`${file}: expected <slug>.<en|fa>.md`);
    const [, slug, lang] = m;
    const { meta, body } = parse(readFileSync(join(dir, file), 'utf8'));
    for (const key of ['title', 'description', 'date']) {
      if (!meta[key]) throw new Error(`${file}: front matter is missing ${key}`);
    }
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, langs: {} });
    bySlug.get(slug).langs[lang] = { meta, html: marked.parse(body) };
  }
  // Newest first, by the date of whichever language carries the article.
  return [...bySlug.values()].sort((a, b) => {
    const d = (x) => Object.values(x.langs)[0].meta.date;
    return d(b).localeCompare(d(a));
  });
}

/** The mark, as the landing pages draw it. Inline so the page needs no request. */
const MARK = readFileSync(join(ROOT, 'landing-en.html'), 'utf8')
  .match(/<svg class="mark"[\s\S]*?<\/svg>/)[0];

function shell({ lang, title, description, canonical, alternates, head, body }) {
  const L = LANGS[lang];
  const W = WORDS[lang];
  const alts = alternates
    .map((a) => `<link rel="alternate" hreflang="${a.lang}" href="${a.href}" />`)
    .join('\n');
  return `<!doctype html>
<html lang="${lang}" dir="${L.dirAttr}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0a0a0a" />
<meta name="color-scheme" content="dark" />

<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${canonical}" />
${alts}
<meta name="robots" content="index, follow, max-image-preview:large" />

<meta property="og:site_name" content="SyxVPN" />
<meta property="og:locale" content="${L.locale}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${canonical}" />
<meta property="og:image" content="${SITE}/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${SITE}/og.png" />

<link rel="stylesheet" href="/landing.css" />
${head}
</head>
<body>

<header class="top">
  <div class="wrap">
    <a class="brand" href="${L.home}" aria-label="SyxVPN">
      ${MARK}
      <span class="brand-name">SYX VPN</span>
    </a>
    <nav class="nav">
      <a href="${L.home}#plans" class="hide-sm">${lang === 'fa' ? 'پلن‌ها' : 'Plans'}</a>
      <a href="/${L.dir}">${W.index}</a>
    </nav>
  </div>
</header>

${body}

<footer class="wrap">
  <nav class="foot-row">
    <a href="${L.home}">${W.home}</a>
    <a href="/${L.dir}">${W.back}</a>
    <a href="/${LANGS[W.otherLang].dir}" hreflang="${W.otherLang}">${W.other}</a>
  </nav>
  <div class="foot"><span>&copy; ${new Date().getFullYear()} SyxVPN</span></div>
</footer>

</body>
</html>
`;
}

function write(relative, html) {
  const path = join(DIST, relative, 'index.html');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  return `/${relative}`;
}

const articles = readArticles();
const routes = ['/', '/fa'];

for (const [lang, L] of Object.entries(LANGS)) {
  const W = WORDS[lang];
  const mine = articles.filter((a) => a.langs[lang]);

  // One card per article, newest first.
  const list = mine.map((a) => {
    const { meta } = a.langs[lang];
    return `      <a class="card article-card" href="/${L.dir}/${a.slug}">
        <h2>${esc(meta.title)}</h2>
        <p>${esc(meta.description)}</p>
        <time datetime="${meta.date}">${meta.date}</time>
      </a>`;
  }).join('\n');

  const indexCanonical = `${SITE}/${L.dir}`;
  const indexAlternates = Object.entries(LANGS)
    .filter(([l]) => articles.some((a) => a.langs[l]))
    .map(([l, o]) => ({ lang: l, href: `${SITE}/${o.dir}` }))
    .concat([{ lang: 'x-default', href: `${SITE}/${LANGS.en.dir}` }]);

  routes.push(write(L.dir, shell({
    lang,
    title: `${W.index} — SyxVPN`,
    description: W.lede,
    canonical: indexCanonical,
    alternates: indexAlternates,
    head: `<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: W.index,
  url: indexCanonical,
  inLanguage: lang,
  isPartOf: { '@type': 'WebSite', name: 'SyxVPN', url: `${SITE}/` },
  hasPart: mine.map((a) => ({
    '@type': 'Article',
    headline: a.langs[lang].meta.title,
    url: `${SITE}/${L.dir}/${a.slug}`,
    datePublished: a.langs[lang].meta.date,
  })),
}, null, 2)}
</script>`,
    body: `<section class="section">
  <div class="wrap">
    <p class="label center">${W.index}</p>
    <h1 style="text-align:center">${W.index}</h1>
    <p class="sub" style="margin-inline:auto;text-align:center">${W.lede}</p>
    <div class="grid articles">
${list}
    </div>
  </div>
</section>`,
  })));

  for (const a of mine) {
    const { meta, html } = a.langs[lang];
    const canonical = `${SITE}/${L.dir}/${a.slug}`;
    const alternates = Object.entries(LANGS)
      .filter(([l]) => a.langs[l])
      .map(([l, o]) => ({ lang: l, href: `${SITE}/${o.dir}/${a.slug}` }));
    if (a.langs.en) alternates.push({ lang: 'x-default', href: `${SITE}/${LANGS.en.dir}/${a.slug}` });

    routes.push(write(`${L.dir}/${a.slug}`, shell({
      lang,
      title: `${meta.title} — SyxVPN`,
      description: meta.description,
      canonical,
      alternates,
      head: `<meta property="article:published_time" content="${meta.date}" />
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Article',
      headline: meta.title,
      description: meta.description,
      datePublished: meta.date,
      dateModified: meta.updated || meta.date,
      inLanguage: lang,
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
      image: `${SITE}/og.png`,
      author: { '@type': 'Organization', name: 'SyxVPN', url: `${SITE}/` },
      publisher: {
        '@type': 'Organization',
        name: 'SyxVPN',
        url: `${SITE}/`,
        logo: { '@type': 'ImageObject', url: `${SITE}/og.png`, width: 1200, height: 630 },
      },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'SyxVPN', item: `${SITE}${L.home}` },
        { '@type': 'ListItem', position: 2, name: W.index, item: `${SITE}/${L.dir}` },
        { '@type': 'ListItem', position: 3, name: meta.title },
      ],
    },
  ],
}, null, 2)}
</script>`,
      body: `<article class="section">
  <div class="wrap prose">
    <nav class="crumbs"><a href="/${L.dir}">${W.back}</a></nav>
    <h1>${esc(meta.title)}</h1>
    <p class="sub">${esc(meta.description)}</p>
    <p class="byline"><time datetime="${meta.updated || meta.date}">${W.updated}: ${meta.updated || meta.date}</time></p>
${html}
  </div>
</article>`,
    })));
  }
}

// ------------------------------------------------------------------- robots
writeFileSync(join(DIST, 'robots.txt'), [
  'User-agent: *',
  'Allow: /',
  // The console and storefront are behind a login and have nothing to index.
  'Disallow: /app',
  '',
  `Sitemap: ${SITE}/sitemap.xml`,
  '',
].join('\n'));

// ------------------------------------------------------------------ sitemap
//
// Only addresses that answer with a page. /en is a 301 to / and is deliberately
// absent: a sitemap of redirects tells a crawler the canonical address is one
// that immediately sends it somewhere else.
const alternatesFor = (route) => {
  if (route === '/' || route === '/fa') {
    return [['en', `${SITE}/`], ['fa', `${SITE}/fa`], ['x-default', `${SITE}/`]];
  }
  const rest = route.replace(/^\/fa\//, '/').replace(/^\//, '');
  const en = `/${rest}`;
  const fa = `/fa/${rest.replace(/^articles/, 'articles')}`;
  const pair = [];
  if (routes.includes(en)) pair.push(['en', `${SITE}${en}`]);
  if (routes.includes(fa)) pair.push(['fa', `${SITE}${fa}`]);
  if (routes.includes(en)) pair.push(['x-default', `${SITE}${en}`]);
  return pair;
};

const today = new Date().toISOString().slice(0, 10);
const urls = routes.map((route) => {
  const links = alternatesFor(route)
    .map(([l, href]) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${href}"/>`)
    .join('\n');
  return `  <url>\n    <loc>${SITE}${route === '/' ? '/' : route}</loc>\n    <lastmod>${today}</lastmod>\n${links}\n  </url>`;
}).join('\n');

writeFileSync(join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n`
  + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`
  + `${urls}\n</urlset>\n`);

console.log(`articles: ${articles.length} in ${Object.keys(LANGS).length} languages`);
console.log(`sitemap: ${routes.length} urls`);
for (const r of routes) console.log(`  ${SITE}${r}`);
