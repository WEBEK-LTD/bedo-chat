import { Global, Module } from '@nestjs/common';
import { ProfilePhotoStorage, SupabaseProfilePhotoStorage } from './profile-photo-storage.js';

@Global()
@Module({
  providers: [{ provide: ProfilePhotoStorage, useClass: SupabaseProfilePhotoStorage }],
  exports: [ProfilePhotoStorage],
})
export class StorageModule {}
