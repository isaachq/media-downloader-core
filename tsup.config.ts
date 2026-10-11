import type {Options} from 'tsup'

const shared: Options = {target: 'node20', sourcemap: true, clean: false}

export default [
  // library: ESM + CJS so it loads in any Electron main process (ESM only works from Electron 28)
  {...shared, entry: {index: 'src/index.ts'}, format: ['esm', 'cjs'], dts: true, clean: true},
  // command line: one self-contained ESM file
  {...shared, entry: {cli: 'src/cli/bin.ts'}, format: ['esm'], banner: {js: '#!/usr/bin/env node'}},
] satisfies Options[]
