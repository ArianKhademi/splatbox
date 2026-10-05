/**
 * Copies the generated result tables into README.md, between their marker comments, so the README
 * cannot drift from what the benchmark and the pipeline run actually produced.
 *
 *   npx tsx scripts/sync_readme.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The part of a generated document worth showing: from its summary line to the end of the section. */
function excerpt(path: string, from: RegExp, until: RegExp): string {
  const lines = readFileSync(join(ROOT, path), 'utf8').split('\n')
  const start = lines.findIndex((line) => from.test(line))
  const end = lines.findIndex((line, i) => i > start && until.test(line))
  if (start < 0) throw new Error(`${path}: no line matches ${from}`)
  return lines
    .slice(start, end < 0 ? undefined : end)
    .join('\n')
    .trim()
}

function inject(readme: string, marker: string, content: string): string {
  const pattern = new RegExp(`(<!-- ${marker}:start -->)[\\s\\S]*?(<!-- ${marker}:end -->)`)
  if (!pattern.test(readme)) throw new Error(`README.md has no ${marker} markers`)
  return readme.replace(pattern, (_match, start: string, end: string) => `${start}\n${content}\n${end}`)
}

const conversion = excerpt('docs/conversion_results.md', /^\*\*Median size reduction/, /^## Environment/)
  // Inside the README the section headings sit one level deeper.
  .replace(/^## Settings$/m, '**Settings**')
const pipeline = excerpt('docs/pipeline_times.md', /^\d+ assets uploaded/, /^$never/)

let readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
readme = inject(readme, 'conversion', conversion)
readme = inject(readme, 'pipeline', pipeline)
writeFileSync(join(ROOT, 'README.md'), readme)
console.log('README.md tables updated')
