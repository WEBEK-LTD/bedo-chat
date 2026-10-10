import { Global, Module } from '@nestjs/common';
import { DeferredTasks } from './deferred-tasks.service.js';
import { MaintenanceService } from './maintenance.service.js';

/** Work after the response and hourly housekeeping, inside the API (D-36). */
@Global()
@Module({
  providers: [DeferredTasks, MaintenanceService],
  exports: [DeferredTasks, MaintenanceService],
})
export class RuntimeModule {}
