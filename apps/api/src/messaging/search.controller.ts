import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { globalSearchQuerySchema, globalSearchResponseSchema } from '@bedo/contracts';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth, UserAuthGuard } from '../auth/user-auth.guard.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SearchService } from './search.service.js';

/** Phase 8: global search (D-42). */
@Controller('v1/search')
@UseGuards(UserAuthGuard)
export class SearchController {
  constructor(@Inject(SearchService) private readonly searchService: SearchService) {}

  @Get()
  @ResponseSchema(globalSearchResponseSchema)
  search(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(globalSearchQuerySchema)) query: z.infer<typeof globalSearchQuerySchema>) {
    return this.searchService.search(auth.userId, query);
  }
}
