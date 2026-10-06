import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FileRole } from './types'

export interface StorageOptions {
  bucket: string
  region: string
  /** Endpoint the api and worker talk to. Unset for real S3. */
  endpoint?: string
  /** Endpoint baked into presigned URLs, when browsers reach the store under a different host than the servers do. */
  publicEndpoint?: string
  forcePathStyle?: boolean
  /** Explicit keys. Left out, the SDK's default chain applies (environment, shared config, instance role). */
  credentials?: { accessKeyId: string; secretAccessKey: string }
}

/** Object keys. Everything an asset owns lives under one of three per-asset prefixes. */
export const keys = {
  upload: (assetId: string, role: FileRole, ext: string) => `uploads/${assetId}/${role}${ext}`,
  converted: (assetId: string) => `converted/${assetId}/model.glb`,
  poster: (assetId: string) => `thumbs/${assetId}/poster.png`,
  turntable: (assetId: string) => `thumbs/${assetId}/turntable.webp`,
  prefixes: (assetId: string) => [`uploads/${assetId}/`, `converted/${assetId}/`, `thumbs/${assetId}/`],
}

const HOUR_MS = 3600_000

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404
}

export class Storage {
  readonly bucket: string
  private readonly client: S3Client
  private readonly signer: S3Client

  constructor(opts: StorageOptions) {
    this.bucket = opts.bucket
    const base: S3ClientConfig = {
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: opts.credentials,
      // Recent SDK versions checksum every PutObject by default, which adds x-amz-checksum-* /
      // x-amz-sdk-checksum-algorithm parameters to presigned PUT URLs. A browser doing a plain
      // fetch PUT never sends the matching checksum, so only compute them when S3 requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }
    this.client = new S3Client({ ...base, endpoint: opts.endpoint })
    // A presigned URL signs the host, so URLs handed to browsers need their own client when the
    // browser-facing endpoint differs (docker compose: servers use minio:9000, browsers localhost:9000).
    this.signer =
      opts.publicEndpoint && opts.publicEndpoint !== opts.endpoint
        ? new S3Client({ ...base, endpoint: opts.publicEndpoint })
        : this.client
  }

  /** URL a browser can PUT the file body to. The Content-Type is signed, so the PUT must send the same one. */
  presignPut(key: string, contentType: string, expiresIn = 900): Promise<string> {
    return getSignedUrl(this.signer, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn })
  }

  /**
   * URL a browser can GET the object from, valid for at least an hour.
   *
   * The signature covers the signing time, so signing "now" would give a different URL on every
   * call and the browser would re-download each thumbnail every time the grid polls. Signing with
   * the clock truncated to the hour returns the same URL all hour, which the HTTP cache can hit.
   */
  presignGet(key: string): Promise<string> {
    const signingDate = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS)
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 2 * 3600, signingDate })
  }

  /** Size and type of an object, or null if it does not exist. */
  async head(key: string): Promise<{ bytes: number; contentType: string | undefined } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { bytes: out.ContentLength ?? 0, contentType: out.ContentType }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async uploadFile(key: string, path: string, contentType: string): Promise<number> {
    const { size } = await stat(path)
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(path), ContentLength: size, ContentType: contentType }),
    )
    return size
  }

  async uploadBuffer(key: string, body: Buffer, contentType: string): Promise<number> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }))
    return body.byteLength
  }

  async downloadToFile(key: string, path: string): Promise<void> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    await pipeline(out.Body as Readable, createWriteStream(path))
  }

  async downloadBuffer(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return Buffer.from(await out.Body!.transformToByteArray())
  }

  /** Deletes every object under the prefix; returns how many were removed. */
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0
    let token: string | undefined
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }))
      const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }))
      if (objects.length > 0) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects, Quiet: true } }))
        deleted += objects.length
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return deleted
  }

  /** Creates the bucket if it is missing. Meant for the local MinIO stand-in, not production S3. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch (err) {
      if (!isNotFound(err)) throw err
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }))
      } catch (createErr) {
        // Another process created it between our check and our create; that is the outcome we wanted.
        if ((createErr as { name?: string }).name !== 'BucketAlreadyOwnedByYou') throw createErr
      }
    }
  }

  destroy(): void {
    this.client.destroy()
    if (this.signer !== this.client) this.signer.destroy()
  }
}
