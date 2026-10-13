import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { API_ENV } from '../config/tokens.js';

export const CHAT_MEDIA_BUCKET = 'chat-media';
export const STICKERS_BUCKET = 'stickers';
export type MediaBucket = typeof CHAT_MEDIA_BUCKET | typeof STICKERS_BUCKET;

/** The real size of a stored object and its first bytes (for type detection). */
export interface ObjectHead {
  size: number;
  head: Buffer;
}

/**
 * Supabase Storage for chat files (Phase 4) and sticker images. Browsers upload with one-time signed URLs that
 * cannot overwrite an existing object and download with short-lived signed URLs; they never hold storage
 * credentials. The API reads the start of every upload back before accepting it.
 */
export abstract class MediaStorage {
  abstract readonly enabled: boolean;
  /** A one-time signed upload URL for a new object (refused if the object already exists). */
  abstract createUpload(bucket: MediaBucket, path: string, contentType: string): Promise<{ url: string; headers: Record<string, string> }>;
  /** The object's size and first `bytes` bytes, or null when it does not exist. */
  abstract head(bucket: MediaBucket, path: string, bytes: number): Promise<ObjectHead | null>;
  /** Stores an object the API produced itself (GIFs, sticker images). Never overwrites. */
  abstract put(bucket: MediaBucket, path: string, body: Buffer, contentType: string): Promise<void>;
  /** Removes objects of unused upload slots or refused uploads (never a file that is part of the history). */
  abstract remove(bucket: MediaBucket, paths: string[]): Promise<void>;
  /** Signed download URLs, in the order given; `download` makes the browser save the file under that name. */
  abstract signedUrls(bucket: MediaBucket, paths: string[], expiresInSeconds: number, download?: string | true): Promise<string[]>;
  /** Address of an object in a public bucket (stickers). */
  abstract publicUrl(bucket: MediaBucket, path: string): string;
}

class StorageRequestError extends Error {}

@Injectable()
export class SupabaseMediaStorage extends MediaStorage {
  readonly enabled: boolean;
  private readonly base: string;
  private readonly key: string;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    super();
    this.enabled = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
    this.base = `${(env.SUPABASE_URL ?? '').replace(/\/$/, '')}/storage/v1`;
    this.key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new StorageRequestError('Storage is not configured');
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.key, authorization: `Bearer ${this.key}`, ...extra };
  }

  private objectPath(bucket: MediaBucket, path: string): string {
    return `${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async createUpload(bucket: MediaBucket, path: string, contentType: string) {
    this.assertEnabled();
    const response = await fetch(`${this.base}/object/upload/sign/${this.objectPath(bucket, path)}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new StorageRequestError(`Could not create an upload URL (${response.status})`);
    }
    const data = (await response.json()) as { url?: string };
    if (!data.url || !data.url.includes('token=')) {
      throw new StorageRequestError('Storage returned no upload URL');
    }
    return { url: `${this.base}${data.url}`, headers: { 'content-type': contentType, 'x-upsert': 'false' } };
  }

  async head(bucket: MediaBucket, path: string, bytes: number): Promise<ObjectHead | null> {
    this.assertEnabled();
    const response = await fetch(`${this.base}/object/authenticated/${this.objectPath(bucket, path)}`, {
      headers: this.headers({ range: `bytes=0-${bytes - 1}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 400 || response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 206 && response.status !== 200) {
      await response.body?.cancel();
      throw new StorageRequestError(`Could not read the stored file (${response.status})`);
    }
    let size: number;
    if (response.status === 206) {
      const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1];
      if (!total) {
        await response.body?.cancel();
        throw new StorageRequestError('Storage gave no object size');
      }
      size = Number(total);
    } else {
      size = Number(response.headers.get('content-length') ?? Number.NaN);
    }
    // Read only the first bytes even if the range was ignored.
    const chunks: Buffer[] = [];
    let read = 0;
    const reader = response.body?.getReader();
    while (reader && read < bytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      read += value.length;
    }
    await reader?.cancel().catch(() => undefined);
    const head = Buffer.concat(chunks).subarray(0, bytes);
    if (!Number.isFinite(size)) {
      throw new StorageRequestError('Storage gave no object size');
    }
    return { size, head };
  }

  async put(bucket: MediaBucket, path: string, body: Buffer, contentType: string): Promise<void> {
    this.assertEnabled();
    const response = await fetch(`${this.base}/object/${this.objectPath(bucket, path)}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': contentType, 'x-upsert': 'false', 'cache-control': 'max-age=31536000' }),
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new StorageRequestError(`Could not store the file (${response.status})`);
    }
    await response.body?.cancel();
  }

  async remove(bucket: MediaBucket, paths: string[]): Promise<void> {
    this.assertEnabled();
    if (paths.length === 0) return;
    const response = await fetch(`${this.base}/object/${bucket}`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: paths }),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
  }

  async signedUrls(bucket: MediaBucket, paths: string[], expiresInSeconds: number, download?: string | true): Promise<string[]> {
    this.assertEnabled();
    if (paths.length === 0) return [];
    const response = await fetch(`${this.base}/object/sign/${bucket}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ expiresIn: expiresInSeconds, paths }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new StorageRequestError(`Could not sign download URLs (${response.status})`);
    }
    const data = (await response.json()) as Array<{ path: string | null; signedURL: string | null }>;
    const byPath = new Map(data.map((item) => [item.path, item.signedURL]));
    const suffix = download === undefined ? '' : `&download=${download === true ? '' : encodeURIComponent(download)}`;
    return paths.map((path) => {
      const signed = byPath.get(path);
      if (!signed) {
        throw new StorageRequestError('Storage did not sign every URL');
      }
      return `${this.base}${signed}${suffix}`;
    });
  }

  publicUrl(bucket: MediaBucket, path: string): string {
    return `${this.base}/object/public/${this.objectPath(bucket, path)}`;
  }
}

/** Detects a file's real type from its first bytes (at least 64 are read); null when unknown. */
export function detectFileType(head: Buffer): string | null {
  const ascii = (start: number, end: number) => head.toString('latin1', start, end);
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF') {
    const form = ascii(8, 12);
    if (form === 'WEBP') return 'image/webp';
    if (form === 'WAVE') return 'audio/wav';
    if (form === 'AVI ') return 'video/x-msvideo';
  }
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return 'audio/mp4';
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return 'video/mp4';
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) {
    // Matroska / WebM: the DocType element names it; WebM files without video are audio (voice messages).
    const text = head.toString('latin1');
    if (!text.includes('webm')) return 'video/x-matroska';
    return 'video/webm';
  }
  if (head.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (head.length >= 4 && ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (head.length >= 3 && ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) {
    // MPEG audio frame (layer bits 01..11) or ADTS AAC (layer 00).
    return (head[1]! & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  }
  if (head.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x504b0304) return 'application/zip';
  if (head.length >= 8 && head.readUInt32BE(0) === 0xd0cf11e0 && head.readUInt32BE(4) === 0xa1b11ae1) return 'application/x-ole-storage';
  if (head.length >= 2 && ascii(0, 2) === 'MZ') return 'application/x-msdownload';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x7f454c46) return 'application/x-executable';
  if (head.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(head.readUInt32BE(0))) return 'application/x-mach-binary';
  return null;
}

/** Programs, refused as files (O-30). */
export const EXECUTABLE_TYPES: ReadonlySet<string> = new Set(['application/x-msdownload', 'application/x-executable', 'application/x-mach-binary']);

/** Width and height of a PNG or WebP image from its first bytes (stickers). */
export function imageSize(data: Buffer): { type: 'image/png' | 'image/webp'; width: number; height: number } | null {
  const type = detectFileType(data);
  if (type === 'image/png' && data.length >= 24 && data.toString('latin1', 12, 16) === 'IHDR') {
    return { type, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (type === 'image/webp' && data.length >= 30) {
    const chunk = data.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      return { type, width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      return { type, width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return { type, width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  }
  return null;
}
