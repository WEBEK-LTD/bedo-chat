import { Global, Module } from '@nestjs/common';
import { QueuesService } from './queues.service.js';

@Global()
@Module({ providers: [QueuesService], exports: [QueuesService] })
export class QueuesModule {}
