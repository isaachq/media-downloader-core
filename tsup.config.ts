import type {Options} from 'tsup'

const shared: Options = {target: 'node20', sourcemap: true, clean: false}

export default [
  // library: ESM + CJS so it loads in any Electron main process (ESM only works from Electron 28)
  // and `detect`: which site a link is, pure (no Node built-ins), for the apps' renderers (Electron, Hermes)
  {
    ...shared,
    entry: {index: 'src/index.ts', detect: 'src/detect.ts'},
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
  },
  // command line: one self-contained ESM file
  {...shared, entry: {cli: 'src/cli/bin.ts'}, format: ['esm'], banner: {js: '#!/usr/bin/env node'}},
] satisfies Options[]
