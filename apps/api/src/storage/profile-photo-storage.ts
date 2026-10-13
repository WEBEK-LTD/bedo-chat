import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { StorageClient } from '@supabase/storage-js';
import { API_ENV } from '../config/tokens.js';

export const PROFILE_PHOTO_BUCKET = 'profile-photos';

export interface StoredObject {
  size: number;
  /** First bytes of the object, for file-type detection. */
  head: Buffer;
}

/**
 * Private storage for profile pictures (P-07, P-15). Browsers upload straight to storage with a
 * one-time signed URL and download with short-lived signed URLs; they never get storage credentials.
 */
export abstract class ProfilePhotoStorage {
  abstract readonly enabled: boolean;
  abstract createUpload(key: string, contentType: string): Promise<{ url: string; headers: Record<string, string> }>;
  abstract read(key: string): Promise<StoredObject | null>;
  abstract remove(key: string): Promise<void>;
  abstract signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

@Injectable()
export class SupabaseProfilePhotoStorage extends ProfilePhotoStorage {
  readonly enabled: boolean;
  private readonly client: StorageClient | null;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    super();
    this.enabled = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
    this.client = this.enabled
      ? new StorageClient(`${env.SUPABASE_URL!.replace(/\/$/, '')}/storage/v1`, {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}`,
        })
      : null;
  }

  private bucket() {
    if (!this.client) {
      throw new Error('Storage is not configured');
    }
    return this.client.from(PROFILE_PHOTO_BUCKET);
  }

  async createUpload(key: string, contentType: string) {
    const { data, error } = await this.bucket().createSignedUploadUrl(key);
    if (error || !data) {
      throw new Error(`Could not create upload URL: ${error?.message ?? 'no data'}`);
    }
    return { url: data.signedUrl, headers: { 'content-type': contentType } };
  }

  async read(key: string): Promise<StoredObject | null> {
    const { data, error } = await this.bucket().download(key);
    if (error || !data) {
      return null;
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    return { size: bytes.length, head: bytes.subarray(0, 16) };
  }

  async remove(key: string): Promise<void> {
    await this.bucket().remove([key]);
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await this.bucket().createSignedUrl(key, expiresInSeconds);
    if (error || !data) {
      throw new Error(`Could not sign URL: ${error?.message ?? 'no data'}`);
    }
    return data.signedUrl;
  }
}

/** Detects the real image type from its first bytes; the declared content type is not trusted. */
export function detectImageType(head: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}
