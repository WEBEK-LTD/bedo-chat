import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { API_ENV } from '../config/tokens.js';

/** One GIF as GIPHY describes it: the small MP4 that is sent and the still frame used as its preview. */
export interface GifItem {
  id: string;
  title: string;
  width: number;
  height: number;
  /** MP4 (fixed height 200 px): what is copied into chat storage when the GIF is sent. */
  mp4Url: string;
  /** Animated preview for the picker (WebP or GIF). */
  previewUrl: string;
  /** First frame (JPEG/GIF): the sent message's preview. */
  stillUrl: string;
}

export class GifProviderError extends Error {}

/** GIF search (O-09). Only the API talks to GIPHY; browsers never do (their address stays private). */
export abstract class GifProvider {
  abstract search(apiKey: string, query: string | null, offset: number, limit: number): Promise<{ items: GifItem[]; total: number }>;
  abstract get(apiKey: string, id: string): Promise<GifItem | null>;
  /** Downloads a GIPHY media file, refusing anything larger than `maxBytes` or from another host. */
  abstract download(url: string, maxBytes: number): Promise<{ body: Buffer; contentType: string }>;
  /** Whether a URL is a GIPHY media address the API may fetch (previews are fetched only from these). */
  abstract isMediaUrl(url: string): boolean;
}

interface GiphyImage {
  url?: string;
  mp4?: string;
  webp?: string;
  width?: string;
  height?: string;
}
interface GiphyGif {
  id?: string;
  title?: string;
  images?: Record<string, GiphyImage | undefined>;
}

@Injectable()
export class GiphyProvider extends GifProvider {
  private readonly base: string;
  private readonly apiHost: string;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    super();
    this.base = env.GIPHY_API_URL.replace(/\/$/, '');
    this.apiHost = new URL(this.base).host;
  }

  isMediaUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        return false;
      }
      // GIPHY serves media from media.giphy.com, media0-4.giphy.com and i.giphy.com. A non-default API address (the
      // stand-in in tests) serves its own media.
      if (/^(media\d?|i)\.giphy\.com$/.test(parsed.hostname) && parsed.port === '') {
        return true;
      }
      return this.apiHost !== 'api.giphy.com' && parsed.host === this.apiHost;
    } catch {
      return false;
    }
  }

  private toItem(gif: GiphyGif): GifItem | null {
    const fixed = gif.images?.fixed_height;
    const preview = gif.images?.fixed_height_small ?? fixed;
    const still = gif.images?.fixed_height_still ?? gif.images?.fixed_height_small_still;
    if (!gif.id || !/^[A-Za-z0-9]{1,64}$/.test(gif.id) || !fixed?.mp4 || !still?.url || !preview) {
      return null;
    }
    const previewUrl = preview.webp ?? preview.url;
    const item = {
      id: gif.id,
      title: (gif.title ?? '').slice(0, 140),
      width: Math.max(1, Math.min(20000, Number(fixed.width) || 1)),
      height: Math.max(1, Math.min(20000, Number(fixed.height) || 1)),
      mp4Url: fixed.mp4,
      previewUrl: previewUrl ?? still.url,
      stillUrl: still.url,
    };
    return this.isMediaUrl(item.mp4Url) && this.isMediaUrl(item.previewUrl) && this.isMediaUrl(item.stillUrl) ? item : null;
  }

  private async call(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this.base}${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    } catch {
      throw new GifProviderError('GIPHY could not be reached');
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GifProviderError(`GIPHY answered ${response.status}`);
    }
    return response.json();
  }

  async search(apiKey: string, query: string | null, offset: number, limit: number) {
    const params = { api_key: apiKey, limit: String(limit), offset: String(offset), rating: 'g', bundle: 'messaging_non_clips' };
    const data = (await (query ? this.call('/gifs/search', { ...params, q: query, lang: 'en' }) : this.call('/gifs/trending', params))) as {
      data?: GiphyGif[];
      pagination?: { total_count?: number };
    } | null;
    const items = (data?.data ?? []).map((gif) => this.toItem(gif)).filter((item): item is GifItem => item !== null);
    return { items, total: Number(data?.pagination?.total_count ?? 0) };
  }

  async get(apiKey: string, id: string) {
    const data = (await this.call(`/gifs/${encodeURIComponent(id)}`, { api_key: apiKey })) as { data?: GiphyGif } | null;
    return data?.data ? this.toItem(data.data) : null;
  }

  async download(url: string, maxBytes: number) {
    if (!this.isMediaUrl(url)) {
      throw new GifProviderError('Not a GIPHY media address');
    }
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    } catch {
      throw new GifProviderError('GIPHY media could not be reached');
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new GifProviderError(`GIPHY media answered ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      await response.body.cancel();
      throw new GifProviderError('GIPHY media is too large');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GifProviderError('GIPHY media is too large');
      }
      chunks.push(Buffer.from(value));
    }
    return { body: Buffer.concat(chunks), contentType: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase() };
  }
}
