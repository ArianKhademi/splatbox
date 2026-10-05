// Copies the Draco glTF decoder that ships with three into public/draco so the viewer can decode
// converted GLBs without calling out to a CDN. Runs before `vite` and `vite build`.
import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// three does not export its package.json, so locate the package root from its main entry (build/three.cjs).
const threeRoot = join(dirname(require.resolve('three')), '..')
const from = join(threeRoot, 'examples/jsm/libs/draco/gltf')
const to = join(dirname(fileURLToPath(import.meta.url)), '../public/draco')

mkdirSync(to, { recursive: true })
for (const file of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) {
  cpSync(join(from, file), join(to, file))
}
console.log(`draco decoder copied to ${to}`)
