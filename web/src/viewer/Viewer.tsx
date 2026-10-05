import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { debugHandle } from './debug'
import { ModelScene, type ModelInfo } from './ModelScene'
import { SplatScene } from './SplatScene'
import { Stage } from './Stage'
import { SyncClock } from './SyncClock'
import { FrameBadge, Timeline } from './TimelineBar'
import type { ClipSource, ViewerAsset } from './types'

/** glTF stores keyframe times in seconds with no frame rate, so frame numbers assume this one. */
export const FPS = 30

/** Per-asset UI state. It is rebuilt from scratch whenever a different asset is opened. */
interface Session {
  assetId: string
  clipIndex: number
  showSkeleton: boolean
  externalClipId: string
  splatScale: number
  alphaThreshold: number
  flipY: boolean
  model: ModelInfo | null
  splatCount: number | null
  videoDuration: number | null
  error: string | null
}

function newSession(asset: ViewerAsset): Session {
  return {
    assetId: asset.id,
    clipIndex: 0,
    showSkeleton: false,
    externalClipId: '',
    splatScale: 1,
    alphaThreshold: 1,
    flipY: asset.flipY ?? false,
    model: null,
    splatCount: null,
    videoDuration: null,
    error: null,
  }
}

function isTyping(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
}

interface ViewerProps {
  asset: ViewerAsset
  /** Motion files the user may apply to a character. */
  clipSources?: ClipSource[]
}

export function Viewer({ asset, clipSources = [] }: ViewerProps) {
  const clock = useMemo(() => new SyncClock(), [])
  const videoRef = useRef<HTMLVideoElement>(null)

  // Opening another asset resets the per-asset state during render, before any child sees stale values.
  const [stored, setSession] = useState(() => newSession(asset))
  const session = stored.assetId === asset.id ? stored : newSession(asset)
  if (session !== stored) setSession(session)
  const patch = useCallback((changes: Partial<Session>) => setSession((s) => ({ ...s, ...changes })), [])

  const isPair = asset.kind === 'pair'
  const clip = session.model?.clips[session.clipIndex]
  const externalClip = clipSources.find((source) => source.id === session.externalClipId)

  // The clock's duration: the clip's, or for a pair the part both the video and the clip cover.
  const duration = isPair
    ? clip && session.videoDuration
      ? Math.min(clip.duration, session.videoDuration)
      : 0
    : (clip?.duration ?? 0)
  useEffect(() => {
    if (duration > 0) clock.load(duration)
    else clock.unload()
  }, [clock, duration])

  useEffect(() => {
    const video = videoRef.current
    if (!isPair || !video) return
    const handle = debugHandle()
    handle.videoTime = () => video.currentTime
    const detach = clock.attachMedia(video)
    return () => {
      detach()
      handle.videoTime = undefined
    }
  }, [clock, isPair, asset.id])

  useEffect(() => {
    debugHandle().clock = clock
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (e.code === 'Space') {
        e.preventDefault()
        clock.toggle()
      } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        e.preventDefault()
        clock.pause()
        clock.seek(clock.getState().time + (e.code === 'ArrowRight' ? 1 : -1) / FPS)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clock])

  const onModelInfo = useCallback((model: ModelInfo) => {
    setSession((s) => {
      // Jump to an external clip the moment one becomes available; otherwise keep the selection in range.
      const firstExternal = model.clips.findIndex((c) => c.external)
      const hadExternal = s.model?.clips.some((c) => c.external) ?? false
      const clipIndex = firstExternal >= 0 && !hadExternal ? firstExternal : Math.min(s.clipIndex, Math.max(model.clips.length - 1, 0))
      return { ...s, model, clipIndex }
    })
  }, [])
  const onSplatInfo = useCallback((info: { splatCount: number }) => patch({ splatCount: info.splatCount }), [patch])
  const onError = useCallback((error: string) => patch({ error }), [patch])

  const readVideo = useCallback(() => videoRef.current?.currentTime ?? null, [])
  const readMixer = useCallback(() => debugHandle().mixerTime?.() ?? null, [])

  const stats = session.model?.stats
  const match = session.model?.externalMatch
  return (
    <div className="viewer" data-kind={asset.kind}>
      <div className="panes" data-pair={isPair}>
        {isPair && (
          <div className="pane video-pane">
            <video
              ref={videoRef}
              key={asset.videoUrl}
              src={asset.videoUrl}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => patch({ videoDuration: e.currentTarget.duration })}
              onError={() => patch({ error: 'The source video could not be loaded.' })}
            />
            <FrameBadge clock={clock} label="video" fps={FPS} read={readVideo} />
          </div>
        )}
        <div className="pane canvas-pane">
          <ErrorBoundary resetKey={asset.id} fallback={(error) => <div className="viewer-error">Could not load this asset: {error.message}</div>}>
            <Stage clock={clock}>
              <Suspense fallback={null}>
                {asset.kind === 'splat'
                  ? asset.splatUrl &&
                    asset.splatFormat && (
                      <SplatScene
                        key={asset.id}
                        url={asset.splatUrl}
                        format={asset.splatFormat}
                        flipY={session.flipY}
                        splatScale={session.splatScale}
                        alphaThreshold={session.alphaThreshold}
                        onInfo={onSplatInfo}
                        onError={onError}
                      />
                    )
                  : asset.modelUrl && (
                      <ModelScene
                        key={asset.id}
                        url={asset.modelUrl}
                        clock={clock}
                        clipIndex={session.clipIndex}
                        showSkeleton={session.showSkeleton}
                        externalClipUrl={externalClip?.url}
                        onInfo={onModelInfo}
                      />
                    )}
              </Suspense>
            </Stage>
          </ErrorBoundary>
          {isPair && <FrameBadge clock={clock} label="motion" fps={FPS} read={readMixer} />}
          {session.error && <div className="viewer-error">{session.error}</div>}
        </div>
      </div>

      {asset.kind !== 'splat' && <Timeline clock={clock} fps={FPS} />}

      <div className="viewer-controls">
        {asset.kind === 'splat' ? (
          <>
            <span className="stat" data-testid="splat-count">
              {session.splatCount === null ? 'loading…' : `${session.splatCount.toLocaleString()} splats`}
            </span>
            <label className="slider">
              Splat scale {session.splatScale.toFixed(2)}
              <input
                type="range"
                aria-label="Splat scale"
                min={0.1}
                max={2}
                step={0.05}
                value={session.splatScale}
                onChange={(e) => patch({ splatScale: Number(e.target.value) })}
              />
            </label>
            <label className="slider">
              Alpha cutoff {session.alphaThreshold}
              <input
                key={asset.id}
                type="range"
                aria-label="Alpha cutoff"
                min={1}
                max={128}
                step={1}
                defaultValue={session.alphaThreshold}
                // The cutoff is applied while the scene is built, so commit it on release, not per pixel of drag.
                onPointerUp={(e) => patch({ alphaThreshold: Number(e.currentTarget.value), splatCount: null })}
                onKeyUp={(e) => patch({ alphaThreshold: Number(e.currentTarget.value), splatCount: null })}
              />
            </label>
            <label className="toggle">
              <input type="checkbox" checked={session.flipY} onChange={(e) => patch({ flipY: e.target.checked })} /> Flip Y
            </label>
          </>
        ) : (
          <>
            <label className="select">
              Clip
              <select
                aria-label="Clip"
                value={session.clipIndex}
                disabled={!session.model || session.model.clips.length === 0}
                onChange={(e) => patch({ clipIndex: Number(e.target.value) })}
              >
                {session.model?.clips.length ? (
                  session.model.clips.map((c, i) => (
                    <option key={i} value={i}>
                      {c.name} ({c.duration.toFixed(2)}s){c.external ? ' · external' : ''}
                    </option>
                  ))
                ) : (
                  <option value={0}>no clips</option>
                )}
              </select>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={session.showSkeleton} onChange={(e) => patch({ showSkeleton: e.target.checked })} /> Skeleton
            </label>
            {clipSources.length > 0 && !isPair && (
              <label className="select">
                Apply clip from
                <select
                  aria-label="External clip"
                  value={session.externalClipId}
                  onChange={(e) => patch({ externalClipId: e.target.value })}
                >
                  <option value="">none</option>
                  {clipSources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {match && (
              <span className="stat" data-testid="clip-match" data-fits={match.bound / Math.max(match.total, 1) >= 0.9}>
                {match.bound}/{match.total} tracks bound{match.missing.length > 0 ? ` · missing ${match.missing.slice(0, 3).join(', ')}` : ''}
              </span>
            )}
            {stats && (
              <span className="stat" data-testid="model-stats">
                {stats.triangles.toLocaleString()} tris · {stats.meshes} meshes · {stats.bones} bones
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
