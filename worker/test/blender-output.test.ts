import { describe, expect, it } from 'vitest'
import { BlenderError, parseBlenderOutput, runBlender } from '../src/blender/run'

const NOISE = 'Blender 4.5.14 LTS\nINFO Draco mesh compression is available\n03:07:50 | INFO: Draco encoder: Encoding mesh fox.\n'

function failure(fn: () => unknown): BlenderError {
  try {
    fn()
  } catch (err) {
    if (err instanceof BlenderError) return err
    throw err
  }
  throw new Error('expected a BlenderError')
}

describe('parseBlenderOutput', () => {
  it('returns the JSON after the last SPLATBOX_RESULT marker on a clean exit', () => {
    const stdout = `${NOISE}SPLATBOX_RESULT {"bytes_after": 123, "seconds": 0.4}\nBlender quit\n`
    expect(parseBlenderOutput(stdout, '', 0)).toEqual({ bytes_after: 123, seconds: 0.4 })
  })

  it('reports the script error on a non-zero exit and marks it as not worth retrying', () => {
    const stdout = `${NOISE}Traceback (most recent call last):\n  File "convert.py", line 80\nSPLATBOX_ERROR ValueError: unsupported input format '.blend'\n`
    const err = failure(() => parseBlenderOutput(stdout, '', 1))
    expect(err.message).toBe("ValueError: unsupported input format '.blend'")
    expect(err.exitCode).toBe(1)
    expect(err.scriptReported).toBe(true)
    expect(err.outputTail).toContain('Traceback')
  })

  it('treats a crash without a script message as retryable and falls back to Blender\'s own error line', () => {
    const err = failure(() => parseBlenderOutput(`${NOISE}Error: Cannot read file "x.glb": No such file\n`, '', 139))
    expect(err.message).toBe('Cannot read file "x.glb": No such file')
    expect(err.scriptReported).toBe(false)
    expect(failure(() => parseBlenderOutput(NOISE, '', 137)).message).toBe('Blender exited with code 137')
  })

  it('does not trust a result line when the exit code is non-zero', () => {
    const stdout = 'SPLATBOX_RESULT {"ok": true}\nSegmentation fault\n'
    expect(failure(() => parseBlenderOutput(stdout, '', 11)).exitCode).toBe(11)
  })

  it('fails when Blender exits cleanly without a result, or with one that is not JSON', () => {
    expect(failure(() => parseBlenderOutput(NOISE, '', 0)).message).toMatch(/reported no result/)
    expect(failure(() => parseBlenderOutput('SPLATBOX_RESULT {oops\n', '', 0)).message).toMatch(/not valid JSON/)
  })
})

describe('runBlender', () => {
  it('rejects with a BlenderError when the binary cannot be started', async () => {
    const run = runBlender({ blenderBin: '/nonexistent/blender', script: 'convert.py', args: [] })
    await expect(run).rejects.toThrow(/could not start Blender/)
  })
})
