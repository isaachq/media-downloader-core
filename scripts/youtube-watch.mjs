// The YouTube watch's verdict (.github/workflows/youtube-watch.yml): reads the
// app's probe report and, when YouTube changed its attestation, opens — or
// updates — one pull request, in English and Spanish, saying what to do. A
// healthy probe closes it. ALERT=none (a pull request run) only sets the exit code.
//
//   node scripts/youtube-watch.mjs <report.json>
import {execFileSync} from 'node:child_process'
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs'

const BRANCH = 'alerts/youtube-attestation'
const FILE = 'docs/alerts/youtube-attestation.md'
const TITLE = 'YouTube changed its attestation — update needed · YouTube cambió su atestación — hay que actualizar'

const reportPath = process.argv[2]
let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch {
  report = undefined
}
const verdict = report?.verdict ?? 'error'
const raise = process.env.ALERT === 'pr'
const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']}).trim()
const openAlert = () => {
  if (!raise) return undefined
  const number = run('gh', ['pr', 'list', '--head', BRANCH, '--state', 'open', '--json', 'number', '--jq', '.[0].number'])
  return number || undefined
}

summary()

if (verdict === 'healthy') {
  const pr = openAlert()
  if (pr) {
    run('gh', ['pr', 'close', pr, '--delete-branch', '--comment', closing()])
    console.log(`healthy again: closed #${pr}`)
  }
  process.exit(0)
}
if (verdict === 'inconclusive') {
  console.log('::warning::YouTube bot-checked this runner: the probe is inconclusive, no alert')
  process.exit(0)
}
if (verdict === 'error') {
  console.log('::error::the probe did not report (it crashed or did not run): see the Probe step')
  process.exit(1)
}

// broken: YouTube changed something the tokens depend on
console.log(`::error::${failure()}`)
// ALERT=preview: the pull request's text, nothing pushed (to read it before it is ever needed)
if (process.env.ALERT === 'preview') console.log(body())
if (raise) {
  const pr = openAlert()
  run('git', ['fetch', 'origin', 'main'])
  run('git', ['checkout', '-B', BRANCH, 'origin/main'])
  writeFileSync(FILE, body()) // the branch starts from main: only this note differs
  run('git', ['add', FILE])
  run('git', [
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit',
    '-m',
    `YouTube watch: ${failure()}`,
  ])
  run('git', ['push', '--force', 'origin', `HEAD:${BRANCH}`])
  if (pr) {
    run('gh', ['pr', 'comment', pr, '--body', `Still broken on ${report.at} · Sigue fallando el ${report.at}\n\n${details()}`])
    console.log(`updated #${pr}`)
  } else {
    try {
      console.log(run('gh', ['pr', 'create', '--head', BRANCH, '--base', 'main', '--title', TITLE, '--body', body()]))
    } catch {
      // the repository doesn't let Actions open pull requests (Settings → Actions → General →
      // "Allow GitHub Actions to create and approve pull requests"): the same alert as an issue
      const open = run('gh', ['issue', 'list', '--state', 'open', '--search', `"${TITLE}" in:title`, '--json', 'number', '--jq', '.[0].number'])
      if (open) run('gh', ['issue', 'comment', open, '--body', details()])
      else console.log(run('gh', ['issue', 'create', '--title', TITLE, '--body', body()]))
    }
  }
}
process.exit(1)

// ─── text ────────────────────────────────────────────────────────────────────

function attestationGone() {
  return !report.strategies.some(s => s.ok)
}

function failure() {
  return attestationGone() ? 'no way passes YouTube’s attestation any more' : 'YouTube refuses the PO tokens the app makes'
}

function failureEs() {
  return attestationGone() ? 'ninguna ruta pasa ya la atestación de YouTube' : 'YouTube rechaza los PO tokens que genera la app'
}

function details() {
  const rows = report.strategies
    .map(s => `| ${s.name} | ${s.ok ? '✅' : '❌'} | ${s.ms} ms | ${s.ok ? `${s.tokenLength} chars` : (s.error ?? '').replaceAll('|', '\\|')} |`)
    .join('\n')
  return [
    '| Way · Ruta | OK | Time · Tiempo | Token / error |',
    '| --- | --- | --- | --- |',
    rows,
    '',
    `yt-dlp ${report.ytDlpVersion ?? '?'} (mweb only · solo mweb): ${report.ytDlp ? `${report.ytDlp.ok ? '✅' : '❌'} ${report.ytDlp.detail}` : 'not run · no se corrió'}`,
    `Engine · Motor: ${report.engine ? `${report.engine.ok ? '✅' : '❌'} ${report.engine.detail}` : 'not run · no se corrió'}`,
    '',
    '<details><summary>Report · Reporte</summary>',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '</details>',
  ].join('\n')
}

function body() {
  return `# ${TITLE}

## English

The daily probe (${report.at}) found that **${failure()}**. YouTube changes this
protocol every few months, usually as an experiment that reaches some sessions
first. Until it is fixed the app keeps working as it did before PO tokens: when
YouTube asks to confirm the user is not a bot, YouTube downloads pause, and the
user is offered to sign in or to wait. Nothing is lost.

**What to do**

1. Read the report below: which way failed (\`youtube\`, \`waa\`) and why.
2. Run the analysis again: what changed, against yt-dlp's PO token guide and
   the projects that follow YouTube closely (BgUtils, bgutil-ytdlp-pot-provider,
   yt-dlp-getpot-wpc) — their recent releases and issues.
3. Patch \`app/src/main/youtube/attestation.ts\` (and \`src/youtube/\` if the
   token contract changed), check it with the probe
   (\`MDC_YOUTUBE_PROBE=report.json\`, see the README), and merge.

This pull request only carries this note; it closes itself once the probe is
healthy again.

## Español

La prueba diaria (${report.at}) encontró que **${failureEs()}**.
YouTube cambia este protocolo cada pocos meses, casi siempre como un experimento
que llega primero a algunas sesiones. Mientras se corrige, la app funciona como
antes de los PO tokens: cuando YouTube pide confirmar que no es un bot, las
descargas de YouTube se pausan y se ofrece iniciar sesión o esperar. No se pierde nada.

**Qué hacer**

1. Revisa el reporte de abajo: qué ruta falló (\`youtube\`, \`waa\`) y por qué.
2. Haz el análisis de nuevo: qué cambió, contra la guía de PO tokens de yt-dlp y
   los proyectos que siguen a YouTube de cerca (BgUtils, bgutil-ytdlp-pot-provider,
   yt-dlp-getpot-wpc) — sus versiones e issues recientes.
3. Corrige \`app/src/main/youtube/attestation.ts\` (y \`src/youtube/\` si cambió el
   contrato del token), compruébalo con la prueba
   (\`MDC_YOUTUBE_PROBE=report.json\`, ver el README) y haz merge.

Este pull request solo lleva esta nota; se cierra solo cuando la prueba vuelve a estar bien.

## Report · Reporte

${details()}
`
}

function closing() {
  return `The probe is healthy again (${report.at}): YouTube's attestation works and its tokens are accepted.
La prueba vuelve a estar bien (${report.at}): la atestación de YouTube funciona y sus tokens se aceptan.`
}

function summary() {
  const file = process.env.GITHUB_STEP_SUMMARY
  const text = report
    ? `## YouTube watch: ${verdict}\n\n${details()}\n`
    : '## YouTube watch: no report\n\nThe probe did not write a report · La prueba no escribió reporte.\n'
  if (file) appendFileSync(file, text)
  else console.log(text)
}
