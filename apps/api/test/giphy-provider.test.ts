import type { ApiEnv } from '@bedo/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GifProviderError, GiphyProvider } from '../src/media/gif-provider.js';

const provider = new GiphyProvider({ GIPHY_API_URL: 'https://api.giphy.com/v1' } as ApiEnv);

/** A search result shaped like GIPHY's `bundle=messaging_non_clips` answer: no still frames. */
const messagingBundleGif = {
  id: 'xT9IgG50Fb7Mi0prBC',
  title: 'Happy Dance',
  images: {
    original: { url: 'https://media3.giphy.com/media/v1.Y2lk/xT9IgG50Fb7Mi0prBC/giphy.gif?cid=1', width: '480', height: '360' },
    fixed_height: {
      url: 'https://media3.giphy.com/media/v1.Y2lk/xT9IgG50Fb7Mi0prBC/200.gif?cid=1',
      mp4: 'https://media3.giphy.com/media/v1.Y2lk/xT9IgG50Fb7Mi0prBC/200.mp4?cid=1',
      webp: 'https://media3.giphy.com/media/v1.Y2lk/xT9IgG50Fb7Mi0prBC/200.webp?cid=1',
      width: '267',
      height: '200',
    },
    fixed_height_small: {
      url: 'https://media3.giphy.com/media/v1.Y2lk/xT9IgG50Fb7Mi0prBC/100.gif?cid=1',
      webp: 'https://media3.giphy.com/media/v1.Y2lk/xT9IgG50Fb7Mi0prBC/100.webp?cid=1',
      width: '133',
      height: '100',
    },
  },
};

function answer(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GiphyProvider (Phase 14.2)', () => {
  it("keeps search results from GIPHY's messaging bundle, which has no still frames", async () => {
    answer(200, { data: [messagingBundleGif], pagination: { total_count: 1 } });
    const result = await provider.search('key', 'dance', 0, 24);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'xT9IgG50Fb7Mi0prBC',
      width: 267,
      height: 200,
      mp4Url: messagingBundleGif.images.fixed_height.mp4,
      previewUrl: messagingBundleGif.images.fixed_height_small.webp,
    });
  });

  it('still drops results without an MP4 or from another host', async () => {
    const noMp4 = { ...messagingBundleGif, images: { ...messagingBundleGif.images, fixed_height: { ...messagingBundleGif.images.fixed_height, mp4: undefined } } };
    const foreign = { ...messagingBundleGif, id: 'abc', images: { ...messagingBundleGif.images, fixed_height_small: { url: 'https://evil.example/x.gif' } } };
    answer(200, { data: [noMp4, foreign], pagination: { total_count: 2 } });
    expect((await provider.search('key', null, 0, 24)).items).toEqual([]);
  });

  it("reports GIPHY's status when it refuses the key", async () => {
    answer(401, { message: 'Unauthorized' });
    const error = await provider.search('wrong', null, 0, 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GifProviderError);
    expect((error as GifProviderError).status).toBe(401);
  });
});
