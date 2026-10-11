import type {Options} from 'tsup'

// ESM + CJS so it loads in any Electron main process (ESM only works from Electron 28)
const options: Options = {entry: ['src/index.ts'], format: ['esm', 'cjs'], target: 'node20', dts: true, sourcemap: true}

export default {...options, clean: true}
