import { useState, type FormEvent } from 'react'
import { api, putFile, type AssetDto, type FileRole } from '../lib/api'
import type { AssetKind } from '../viewer/types'

const ACCEPT: Record<'model' | 'splat' | 'video', string> = {
  model: '.glb,.gltf,.fbx,.obj',
  splat: '.ply,.splat,.ksplat',
  video: '.mp4,.webm,.mov',
}

const KIND_HELP: Record<AssetKind, string> = {
  character: 'A rigged or static model: GLB, FBX or OBJ.',
  clip: 'A file that carries animation clips: GLB or FBX.',
  splat: 'A Gaussian splat scene: .ply, .splat or .ksplat.',
  pair: 'A source video and the motion GLB generated from it.',
}

export function UploadForm({ onUploaded }: { onUploaded: (asset: AssetDto) => void }) {
  const [kind, setKind] = useState<AssetKind>('character')
  const [name, setName] = useState('')
  const [main, setMain] = useState<File | null>(null)
  const [video, setVideo] = useState<File | null>(null)
  const [flipY, setFlipY] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ready = main !== null && (kind !== 'pair' || video !== null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!main) return
    const picked: { role: FileRole; file: File }[] =
      kind === 'pair' ? [{ role: 'video', file: video! }, { role: 'motion', file: main }] : [{ role: 'source', file: main }]
    setError(null)
    try {
      setProgress('Requesting upload URLs…')
      const { asset, uploads } = await api.createAsset({
        name: name.trim() || main.name.replace(/\.[^.]+$/, ''),
        kind,
        flipY: kind === 'splat' ? flipY : undefined,
        files: picked.map(({ role, file }) => ({ role, filename: file.name, contentType: file.type || 'application/octet-stream' })),
      })
      for (const { role, file } of picked) {
        setProgress(`Uploading ${file.name}…`)
        await putFile(uploads.find((u) => u.role === role)!, file)
      }
      setProgress('Queueing jobs…')
      onUploaded(await api.completeUpload(asset.id))
      setName('')
      setMain(null)
      setVideo(null)
      ;(e.target as HTMLFormElement).reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProgress(null)
    }
  }

  return (
    <form className="upload" onSubmit={submit} data-testid="upload-form">
      <label>
        Kind
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as AssetKind)}>
          <option value="character">character</option>
          <option value="clip">clip</option>
          <option value="splat">splat</option>
          <option value="pair">pair (video + motion)</option>
        </select>
      </label>
      <label>
        Name
        <input type="text" aria-label="Name" placeholder="defaults to the file name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </label>
      {kind === 'pair' && (
        <label>
          Source video
          <input type="file" aria-label="Source video" accept={ACCEPT.video} onChange={(e) => setVideo(e.target.files?.[0] ?? null)} />
        </label>
      )}
      <label>
        {kind === 'pair' ? 'Motion GLB' : 'File'}
        <input
          type="file"
          aria-label={kind === 'pair' ? 'Motion file' : 'Asset file'}
          accept={kind === 'splat' ? ACCEPT.splat : ACCEPT.model}
          onChange={(e) => setMain(e.target.files?.[0] ?? null)}
        />
      </label>
      {kind === 'splat' && (
        <label className="toggle">
          <input type="checkbox" checked={flipY} onChange={(e) => setFlipY(e.target.checked)} /> Scene is Y-down (COLMAP)
        </label>
      )}
      <button type="submit" disabled={!ready || progress !== null}>
        {progress ?? 'Upload'}
      </button>
      <p className="hint">{KIND_HELP[kind]}</p>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
