import { Module } from '@nestjs/common';
import { GifProvider, GiphyProvider } from './gif-provider.js';
import { GifsService } from './gifs.service.js';
import { MediaViewsService } from './media-views.service.js';
import { StickersService } from './stickers.service.js';

/** Phase 4: media views, stickers (O-10) and GIFs (O-09). Files and reactions live with messaging. */
@Module({
  providers: [MediaViewsService, StickersService, GifsService, { provide: GifProvider, useClass: GiphyProvider }],
  exports: [MediaViewsService, StickersService, GifsService],
})
export class MediaModule {}
