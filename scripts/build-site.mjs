// Builds the website's language pages from docs/index.html (the English page, the
// template) and docs/i18n/<code>.json (one file per language):
//
//   docs/<code>/index.html  every language but English, written in that language
//   docs/index.html         the English page itself: only its generated parts
//   docs/sitemap.xml        every page with its alternates (hreflang)
//   README.md               only its supported-sites table
//
// Generated parts sit between markers (<!-- seo:start -->, /*i18n:start*/, …) so the
// build can run again. The languages are the desktop app's (app/src/shared/contract.ts);
// the supported sites and their words too (app/src/shared/sites.ts, site-words.ts).
//
//   node scripts/build-site.mjs          write the pages
//   node scripts/build-site.mjs --check  fail when a page is not what the build writes
//   node scripts/build-site.mjs --english  print the English words, to start a translation
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {tsImport} from 'tsx/esm/api'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// the app's own list, read as TypeScript on any Node the CI runs (tsx, not type stripping)
const {SITES} = await tsImport(pathToFileURL(join(ROOT, 'app/src/shared/sites.ts')).href, import.meta.url)
const {SITE_WORDS} = await tsImport(pathToFileURL(join(ROOT, 'app/src/shared/site-words.ts')).href, import.meta.url)
const DOCS = join(ROOT, 'docs')
const SITE = 'https://isaachq.github.io/media-downloader-core/'
const RELEASES = 'https://github.com/isaachq/media-downloader-core/releases'

/** code: the app's code; tag: the page's BCP 47 tag; hreflang; og: Open Graph locale. */
const LANGUAGES = [
  {code: 'en', tag: 'en', hreflang: 'en', og: 'en_US'},
  {code: 'es', tag: 'es', hreflang: 'es', og: 'es_LA'},
  {code: 'pt', tag: 'pt-BR', hreflang: 'pt', og: 'pt_BR'},
  {code: 'id', tag: 'id', hreflang: 'id', og: 'id_ID'},
  {code: 'hi', tag: 'hi', hreflang: 'hi', og: 'hi_IN'},
  {code: 'vi', tag: 'vi', hreflang: 'vi', og: 'vi_VN'},
  {code: 'th', tag: 'th', hreflang: 'th', og: 'th_TH'},
  {code: 'tr', tag: 'tr', hreflang: 'tr', og: 'tr_TR'},
  {code: 'ar', tag: 'ar', hreflang: 'ar', og: 'ar_AR', dir: 'rtl'},
  {code: 'fr', tag: 'fr', hreflang: 'fr', og: 'fr_FR'},
  {code: 'de', tag: 'de', hreflang: 'de', og: 'de_DE'},
  {code: 'ru', tag: 'ru', hreflang: 'ru', og: 'ru_RU'},
  {code: 'zh', tag: 'zh-Hans', hreflang: 'zh-Hans', og: 'zh_CN'},
  {code: 'it', tag: 'it', hreflang: 'it', og: 'it_IT'},
]

const check = process.argv.includes('--check')
const problems = []

// the app's own list: the website speaks exactly its languages, named as the app names them
const contract = readFileSync(join(ROOT, 'app/src/shared/contract.ts'), 'utf8')
const appCodes = JSON.parse(
  contract
    .match(/export const LANGUAGES = (\[[^\]]*\])/)[1]
    .replaceAll("'", '"'),
)
const native = Object.fromEntries(
  [...contract.matchAll(/^\s+(\w+): '([^']+)',$/gm)].filter(([, code]) => appCodes.includes(code)).map(([, c, n]) => [c, n]),
)
const siteCodes = LANGUAGES.map(language => language.code)
if (appCodes.length !== siteCodes.length || appCodes.some(code => !siteCodes.includes(code)))
  problems.push(`the app speaks ${appCodes.join(', ')}; the site ${siteCodes.join(', ')}`)

const escapeAttr = value =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const unescapeAttr = value =>
  value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
const between = (text, start, end, inner) => {
  const a = text.indexOf(start)
  const b = text.indexOf(end, a)
  if (a < 0 || b < 0) throw new Error(`no ${start} … ${end} in docs/index.html`)
  return text.slice(0, a + start.length) + inner + text.slice(b)
}

// the supported sites, in one language: O(sites) per page
const siteRows = code => {
  const words = SITE_WORDS[code]
  return SITES.map(entry => ({
    entry,
    name: entry.brand ?? (entry.site === 'web' ? words.nameWeb : words.nameFile),
    what: words.what[entry.site],
    signIn: entry.signIn ? words.signInFor.replace('{what}', words.needs[entry.site]) : words.notNeeded,
    phone: entry.phone ? words.yes : words.desktopOnly,
  }))
}
const sitesSection = code => {
  const words = SITE_WORDS[code]
  const rows = siteRows(code)
    .map(
      row =>
        `\n        <tr data-site="${row.entry.site}"><th scope="row">${escapeAttr(row.name)}</th><td>${escapeAttr(row.what)}</td><td${row.entry.signIn ? '' : ' class="muted"'}>${row.entry.signIn ? `<a href="#signin">${escapeAttr(row.signIn)}</a>` : escapeAttr(row.signIn)}</td><td${row.entry.phone ? '' : ' class="muted"'}>${escapeAttr(row.phone)}</td></tr>`,
    )
    .join('')
  return `
    <h2>${escapeAttr(words.title)}</h2>
    <p class="intro">${escapeAttr(words.intro)}</p>
    <div class="sites-table">
      <table>
        <thead><tr><th scope="col">${escapeAttr(words.colSite)}</th><th scope="col">${escapeAttr(words.colWhat)}</th><th scope="col">${escapeAttr(words.colSignIn)}</th><th scope="col">${escapeAttr(words.colPhone)}</th></tr></thead>
        <tbody>${rows}
        </tbody>
      </table>
    </div>
    `
}
// the README's table, in English, with how each site is read
const readmeSites = () => {
  const words = SITE_WORDS.en
  const cell = text => text.replaceAll('|', '\\|')
  const lines = [
    `| ${words.colSite} | ${words.colWhat} | ${words.colSignIn} | Read by | ${words.colPhone} |`,
    '| --- | --- | --- | --- | --- |',
    ...siteRows('en').map(
      row =>
        `| ${cell(row.name)} | ${cell(row.what)} | ${cell(row.signIn)} | ${row.entry.engine === 'native' ? 'the library' : 'yt-dlp'} | ${cell(row.phone)} |`,
    ),
  ]
  return `\n${lines.join('\n')}\n`
}

const template = readFileSync(join(DOCS, 'index.html'), 'utf8')

// the English words: the elements' own text, the translated attributes and the script's
const ELEMENT = /<(\w+)\b([^>]*?)\sdata-i18n="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g
const ATTRIBUTES = {alt: 'alt', aria: 'aria-label', content: 'content', placeholder: 'placeholder'}
const english = {}
for (const [, tag, , key, , inner] of template.matchAll(ELEMENT)) {
  if (new RegExp(`<${tag}\\b`).test(inner)) problems.push(`data-i18n="${key}" holds another <${tag}>`)
  english[key] = inner
}
for (const [kind, attribute] of Object.entries(ATTRIBUTES)) {
  const pattern = new RegExp(`<[^>]*\\sdata-i18n-${kind}="([^"]+)"[^>]*>`, 'g')
  for (const [element, key] of template.matchAll(pattern)) {
    const value = element.match(new RegExp(`\\s${attribute}="([^"]*)"`))
    if (!value) problems.push(`data-i18n-${kind}="${key}" without ${attribute}`)
    else english[key] ??= unescapeAttr(value[1])
  }
}
const runtime = Function(`return ${template.match(/const en = (\{.*\})\n/)[1]}`)()
Object.assign(english, runtime)

if (process.argv.includes('--english')) {
  console.log(JSON.stringify(english, null, 2))
  process.exit(0)
}

const urlOf = code => (code === 'en' ? SITE : `${SITE}${code}/`)
const display = code => new Intl.DisplayNames([code], {type: 'language'})

const page = language => {
  const {code, tag, og, dir} = language
  const words = code === 'en' ? english : JSON.parse(readFileSync(join(DOCS, 'i18n', `${code}.json`), 'utf8'))
  for (const key of Object.keys(english)) if (!(key in words)) problems.push(`${code}.json: no "${key}"`)
  for (const key of Object.keys(words)) if (!(key in english)) problems.push(`${code}.json: "${key}" is not on the page`)
  const word = key => words[key] ?? english[key]
  const base = code === 'en' ? './' : '../'
  const hrefOf = other => (other === 'en' ? base : other === code ? './' : `${base}${other}/`)
  let html = template

  if (code !== 'en') {
    html = html.replace(ELEMENT, (element, tagName, before, key, after, inner) =>
      element.replace(`>${inner}</${tagName}>`, `>${word(key)}</${tagName}>`),
    )
    for (const [kind, attribute] of Object.entries(ATTRIBUTES)) {
      const pattern = new RegExp(`<[^>]*\\sdata-i18n-${kind}="([^"]+)"[^>]*>`, 'g')
      html = html.replace(pattern, (element, key) =>
        element.replace(new RegExp(`(\\s${attribute}=")[^"]*"`), `$1${escapeAttr(word(key))}"`),
      )
    }
    // the pages sit one folder down: relative links climb back to docs/
    html = html.replace(/(\s(?:src|href|poster)=")(?!https?:|#|\/|mailto:|data:|\.\.\/)([^"]+")/g, '$1../$2')
  }

  html = html.replace(
    /<html[^>]*>/,
    `<html lang="${tag}"${dir ? ` dir="${dir}"` : ''} data-lang="${code}" data-root="${base}">`,
  )

  const names = display(code)
  const others = LANGUAGES.map(other => {
    const own = native[other.code]
    const here = names.of(other.tag)
    const inEnglish = display('en').of(other.tag)
    const search = [own, here, inEnglish, other.code, other.tag].join(' ')
    return {...other, own, here, search, href: hrefOf(other.code)}
  })
  const dialog = others
    .map(
      other =>
        `\n    <li data-search="${escapeAttr(other.search)}"><a href="${other.href}" hreflang="${other.hreflang}" data-lang-code="${other.code}"${other.code === code ? ' aria-current="true"' : ''}><span lang="${other.tag}" dir="auto">${other.own}</span><span class="lang-other">${other.here}</span></a></li>`,
    )
    .join('')
  const footer = others
    .map(
      other =>
        `<a href="${other.href}" hreflang="${other.hreflang}" lang="${other.tag}" data-lang-code="${other.code}"${other.code === code ? ' aria-current="page"' : ''}>${other.own}</a>`,
    )
    .join(' ')
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Media Download Core',
    description: word('meta.description'),
    url: urlOf(code),
    inLanguage: tag,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'macOS, Windows, Linux',
    offers: {'@type': 'Offer', price: '0', priceCurrency: 'USD'},
    downloadUrl: RELEASES,
    image: `${SITE}og-image.jpg`,
    screenshot: `${SITE}screenshots/preview.png`,
    license: 'https://polyformproject.org/licenses/noncommercial/1.0.0/',
    author: {'@type': 'Person', name: 'isaachq', url: 'https://github.com/isaachq'},
    sameAs: 'https://github.com/isaachq/media-downloader-core',
  }
  const seo = [
    `<link rel="canonical" href="${urlOf(code)}">`,
    ...LANGUAGES.map(other => `<link rel="alternate" hreflang="${other.hreflang}" href="${urlOf(other.code)}">`),
    `<link rel="alternate" hreflang="x-default" href="${SITE}">`,
    `<meta property="og:url" content="${urlOf(code)}">`,
    `<meta property="og:locale" content="${og}">`,
    ...LANGUAGES.filter(other => other.code !== code).map(
      other => `<meta property="og:locale:alternate" content="${other.og}">`,
    ),
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('<', '\\u003c')}</script>`,
  ].join('\n')
  const dynamic = Object.fromEntries(Object.keys(runtime).map(key => [key, word(key)]))

  html = between(html, '<!-- seo:start -->', '<!-- seo:end -->', `\n${seo}\n`)
  html = between(html, '<!-- sites:start -->', '<!-- sites:end -->', sitesSection(code))
  html = between(html, '<!-- langs:dialog:start -->', '<!-- langs:dialog:end -->', `${dialog}\n  `)
  html = between(html, '<!-- langs:footer:start -->', '<!-- langs:footer:end -->', footer)
  html = between(html, '/*languages:start*/', '/*languages:end*/', JSON.stringify(siteCodes).replaceAll('"', "'"))
  html = between(html, '/*i18n:start*/', '/*i18n:end*/', code === 'en' ? '{}' : JSON.stringify(dynamic))
  html = html.replace(
    /(<span class="lang-current" id="lang-current">)[^<]*(<\/span>)/,
    `$1${native[code]}$2`,
  )
  return html
}

const sitemap = () => {
  const alternates = LANGUAGES.map(
    other => `    <xhtml:link rel="alternate" hreflang="${other.hreflang}" href="${urlOf(other.code)}"/>`,
  )
  alternates.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}"/>`)
  const urls = LANGUAGES.map(
    language => `  <url>\n    <loc>${urlOf(language.code)}</loc>\n${alternates.join('\n')}\n  </url>`,
  )
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`
}

const outputs = new Map()
for (const language of LANGUAGES)
  outputs.set(language.code === 'en' ? 'index.html' : `${language.code}/index.html`, page(language))
outputs.set('sitemap.xml', sitemap())
outputs.set(
  '../README.md',
  between(readFileSync(join(ROOT, 'README.md'), 'utf8'), '<!-- sites:start -->', '<!-- sites:end -->', readmeSites()),
)

if (problems.length) {
  console.error(problems.map(problem => `  ✗ ${problem}`).join('\n'))
  process.exit(1)
}
let stale = 0
for (const [file, content] of outputs) {
  const path = join(DOCS, file)
  let current
  try {
    current = readFileSync(path, 'utf8')
  } catch {}
  if (current === content) continue
  if (check) {
    console.error(`  ✗ docs/${file} is not up to date: run node scripts/build-site.mjs`)
    stale++
  } else {
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, content)
    console.log(`  ✓ docs/${file}`)
  }
}
if (stale) process.exit(1)
if (check) console.log(`  ✓ the website's ${LANGUAGES.length} languages are up to date`)
