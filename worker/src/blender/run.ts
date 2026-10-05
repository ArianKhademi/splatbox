import { spawn } from 'node:child_process'

const RESULT_PREFIX = 'SPLATBOX_RESULT '
const ERROR_PREFIX = 'SPLATBOX_ERROR '

/** A Blender run that did not produce a result. */
export class BlenderError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    /**
     * True when the script itself reported the failure (bad input, unsupported format). Running
     * it again would fail the same way, so the queue should not retry.
     */
    readonly scriptReported: boolean,
    /** The tail of Blender's output, kept for the job's error record. */
    readonly outputTail: string,
  ) {
    super(message)
    this.name = 'BlenderError'
  }
}

function tail(text: string, lines = 15): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

function lastLineWith(text: string, prefix: string): string | null {
  const line = text
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : null
}

/**
 * Turns a finished Blender process into its JSON result or a BlenderError.
 *
 * The scripts print `SPLATBOX_RESULT {json}` on success and `SPLATBOX_ERROR message` before exiting
 * non-zero. Blender's own failures (a crash, a Python error outside the script's handler) show up
 * only as a non-zero exit code, so both channels are checked: the exit code decides success, and
 * stdout supplies either the result or the most specific error message available.
 */
export function parseBlenderOutput<T>(stdout: string, stderr: string, exitCode: number | null): T {
  const reported = lastLineWith(stdout, ERROR_PREFIX)
  if (exitCode !== 0) {
    const fallback = lastLineWith(stdout, 'Error: ') ?? lastLineWith(stderr, 'Error: ')
    const message = reported ?? fallback ?? `Blender exited with code ${exitCode}`
    throw new BlenderError(message, exitCode, reported !== null, tail(`${stdout}\n${stderr}`))
  }
  const result = lastLineWith(stdout, RESULT_PREFIX)
  if (result === null) {
    throw new BlenderError('Blender exited cleanly but the script reported no result', exitCode, false, tail(stdout))
  }
  try {
    return JSON.parse(result) as T
  } catch {
    throw new BlenderError('the script result is not valid JSON', exitCode, false, tail(stdout))
  }
}

export interface BlenderRunOptions {
  blenderBin: string
  /** Absolute path of the Python script to run. */
  script: string
  /** Arguments for the script, placed after Blender's `--` separator. */
  args: string[]
  timeoutMs?: number
}

/** Runs one Python script in a headless Blender and resolves with the script's JSON result. */
export function runBlender<T>(opts: BlenderRunOptions): Promise<T> {
  const argv = [
    '-b', // background: no window
    '--factory-startup', // ignore user preferences and startup files, so every host behaves the same
    '-noaudio',
    '--python-exit-code',
    '1', // make an uncaught Python exception exit non-zero instead of 0
    '--python',
    opts.script,
    '--',
    ...opts.args,
  ]
  return new Promise<T>((resolve, reject) => {
    const child = spawn(opts.blenderBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs ?? 10 * 60_000)

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new BlenderError(`could not start Blender at "${opts.blenderBin}": ${err.message}`, null, false, ''))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new BlenderError('Blender timed out and was killed', code, false, tail(stdout)))
      try {
        resolve(parseBlenderOutput<T>(stdout, stderr, code))
      } catch (err) {
        reject(err)
      }
    })
  })
}
