// The package as a consumer gets it: `npm pack` the built library, install the tarball in an
// empty project and load it both ways — `import` (ESM) and `require` (CJS). Run after
// `npm run build`; CI runs it on every platform. Exit 1 on any failure.
//
//   npm run pack:check
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// npm through this very node, no shell: the same command on Windows and POSIX, nothing concatenated.
// Under `npm run` npm says where it is; otherwise it sits beside node (Windows) or under lib/ (POSIX).
const npmCli = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(candidate => candidate && fs.existsSync(candidate))
if (!npmCli) {
  console.error('npm-cli.js not found beside this node; run through `npm run pack:check`')
  process.exit(1)
}
const sh = (args, cwd) =>
  execFileSync(process.execPath, [npmCli, ...args], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']})

if (!fs.existsSync(path.join(root, 'dist', 'index.js')) || !fs.existsSync(path.join(root, 'dist', 'index.cjs'))) {
  console.error('dist/ is missing: run `npm run build` first')
  process.exit(1)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-pack-'))
try {
  const packed = JSON.parse(sh(['pack', '--json', '--pack-destination', work], root))
  const tarball = path.join(work, packed[0].filename)
  console.log(`packed ${packed[0].filename} (${packed[0].files.length} files, ${packed[0].unpackedSize} B unpacked)`)

  const consumer = path.join(work, 'consumer')
  fs.mkdirSync(consumer)
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({name: 'consumer', version: '0.0.0', private: true}))
  sh(['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], consumer)

  fs.writeFileSync(
    path.join(consumer, 'esm.mjs'),
    [
      "import {MediaDownloader, BatchScheduler, genericChoices} from 'media-downloader-core'",
      "if (typeof MediaDownloader !== 'function' || typeof BatchScheduler !== 'function') throw new Error('esm: classes missing')",
      "if (genericChoices().length < 26) throw new Error('esm: fewer than 26 profiles')",
      "console.log('esm ok')",
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(consumer, 'cjs.cjs'),
    [
      "const lib = require('media-downloader-core')",
      "if (typeof lib.MediaDownloader !== 'function' || typeof lib.BatchScheduler !== 'function') throw new Error('cjs: classes missing')",
      "if (lib.genericChoices().length < 26) throw new Error('cjs: fewer than 26 profiles')",
      "console.log('cjs ok')",
    ].join('\n'),
  )
  for (const entry of ['esm.mjs', 'cjs.cjs']) {
    const out = execFileSync(process.execPath, [entry], {cwd: consumer, encoding: 'utf8'})
    process.stdout.write(out)
  }
  // the CLI the tarball ships
  const cli = execFileSync(process.execPath, [path.join(consumer, 'node_modules', 'media-downloader-core', 'dist', 'cli.js'), '--version'], {encoding: 'utf8'})
  console.log('cli ok', cli.trim())
} finally {
  fs.rmSync(work, {recursive: true, force: true})
}
