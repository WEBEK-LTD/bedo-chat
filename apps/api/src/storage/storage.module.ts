import { Global, Module } from '@nestjs/common';
import { MediaStorage, SupabaseMediaStorage } from './media-storage.js';
import { ProfilePhotoStorage, SupabaseProfilePhotoStorage } from './profile-photo-storage.js';

@Global()
@Module({
  providers: [
    { provide: ProfilePhotoStorage, useClass: SupabaseProfilePhotoStorage },
    { provide: MediaStorage, useClass: SupabaseMediaStorage },
  ],
  exports: [ProfilePhotoStorage, MediaStorage],
})
export class StorageModule {}
