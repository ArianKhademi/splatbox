# Architecture

```
            ┌───────────────────────────┐   presigned PUT / GET    ┌──────────────────────────────┐
            │ browser                   │ ───────────────────────► │ S3 (MinIO locally)           │
            │ React + Three.js viewer   │                          │ uploads/{id}/                │
            └────────────┬──────────────┘                          │ converted/{id}/model.glb     │
                         │ /api (cookie or bearer token)           │ thumbs/{id}/poster.png       │
                         ▼                                         │ thumbs/{id}/turntable.webp   │
            ┌───────────────────────────┐                          └──────────────▲───────────────┘
            │ api (Fastify)             │                                         │ get / put
            │ assets, presigning, jobs  │──── SQLite (assets, files, jobs) ───┐   │
            └────────────┬──────────────┘                                     │   │
                         │ BullMQ flow: convert ─► turntable                  │   │
                         ▼                                                    │   │
            ┌───────────────────────────┐        ┌────────────────────────────┴───┴─────┐
            │ Redis (queue "assets")    │ ─────► │ worker (Node + TypeScript)           │
            └───────────────────────────┘        │  convert:   blender -b convert.py    │
                                                 │  turntable: blender -b turntable.py  │
                                                 │             or headless Chromium     │
                                                 └──────────────────────────────────────┘
```

## Packages

| Path | What it is |
| --- | --- |
| `web/` | React 18 + Vite app. `src/viewer/` is the previewer; `src/pages/` is the browse grid, asset page, and demo page; `src/render/` is the bare page the worker drives for splat turntables. |
| `api/` | Fastify app. Owns the HTTP surface, presigns uploads and downloads, and enqueues jobs. |
| `worker/` | BullMQ worker. `src/` is TypeScript; `blender/` holds the two Python scripts Blender runs. |
| `shared/` | Code both Node processes need: config, the SQLite store, the S3 wrapper, queue definitions, the GLB inspector. Not listed in the original three-package layout; it exists so the api and worker cannot drift apart on schema or key layout. |
| `scripts/` | Benchmark, sample-set and demo-asset builders, the pipeline run, README captures. |

## The life of an upload

1. **Create.** `POST /api/assets` validates kind, roles and extensions, inserts the asset as
   `uploading`, and returns one presigned PUT URL per file. Pairs get two (video and motion).
2. **Upload.** The browser PUTs each file straight to object storage. The api never sees the bytes.
3. **Complete.** `POST /api/assets/:id/complete` HEADs each object to confirm it arrived, records
   sizes, inserts the job rows, and enqueues. Models get a BullMQ *flow* with `turntable` as the
   parent of `convert`; BullMQ holds a parent in `waiting-children` until its children complete, so
   the turntable cannot run before the converted GLB exists. Splat scenes get a lone `turntable`.
4. **Convert.** The worker downloads the source, runs `blender -b --python convert.py`, inspects
   the output GLB, uploads it, and records before/after bytes, triangles, and texture counts.
5. **Turntable.** The worker renders 24 views 15° apart at 512×512 (Blender EEVEE for models,
   headless Chromium for splats), encodes a looping WebP and a poster PNG with sharp, uploads both.
6. **Browse.** The grid polls while anything is processing and shows posters as cards scroll into view.

Job options: concurrency 2 per worker, one try plus up to 3 retries with exponential backoff
(2 s, 4 s, 8 s). An error the Blender script reports itself (unsupported format, empty file) is
rethrown as unrecoverable so it is not retried; a crash, timeout, or storage error is.

## Decisions worth knowing

**SQLite, not Postgres.** The demo runs on one host, where one SQLite file in WAL mode is the
whole database: no service to run, and `better-sqlite3`'s synchronous API keeps every store method
a single statement or transaction. The api and worker open the same file (a shared volume under
Compose). The cost is that both must be on one machine; the store is one class (`shared/src/db.ts`)
so swapping it for Postgres is contained when the worker needs to move to its own host.

**One persistent canvas.** The viewer keeps a single `<Canvas>` and WebGL context for its
lifetime and swaps assets in and out as children. That makes disposal a real obligation (three.js
frees nothing on its own), which `web/e2e/memory.spec.ts` checks by switching 50 times and
comparing `renderer.info.memory`.

**One clock.** `SyncClock` owns transport state and a single `time`, and poses every target with
`setTime(time)`, so playing and scrubbing share one code path. In pair mode the video's media
clock is the timebase while playing (a browser cannot be made to step a video frame by frame
without seeking), and the clock writes into the video only when the user chooses the time.

**Blender scripts are plain CLIs.** Each takes explicit arguments after `--`, prints
`SPLATBOX_RESULT {json}` on success and `SPLATBOX_ERROR message` before a non-zero exit. Blender
exits 0 after an uncaught Python exception unless told otherwise, so the worker also passes
`--python-exit-code 1` and treats a clean exit without a result line as a failure.

**Textures are encoded one at a time.** `convert.py` re-encodes each texture itself and keeps the
original whenever the result is not smaller or Blender cannot write that image in the target
format, then lets the exporter copy bytes through. The exporter's own "convert everything to
WebP" mode silently dropped textures it failed to encode; see the README.

**Splat turntables come from the viewer's own code.** Blender cannot render Gaussian splats, so
the worker opens `web/render.html` in headless Chromium. Playwright answers the page's request for
the scene from local disk, so no storage URL, credential, or CORS rule is involved.

**Presigned GET URLs are stable for an hour.** They are signed with the clock truncated to the
hour, so repeated list calls return identical URLs and the browser cache can hit.

## Auth

Demo-grade and deliberately minimal. Reading (listing, viewing, failed jobs, queue counts) is
open to anyone with the link, so a visitor can browse without an account. Creating, retrying and
deleting assets need one shared token from the environment: scripts send it as a bearer token;
the web app exchanges it once for an HTTP-only cookie holding an expiry and an HMAC of it. There
are no users or per-asset permissions.
