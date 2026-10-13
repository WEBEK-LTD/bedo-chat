import { Global, Module } from '@nestjs/common';
import { DeferredTasks } from './deferred-tasks.service.js';
import { MaintenanceService } from './maintenance.service.js';
import { MonitoringService } from './monitoring.service.js';

/** Work after the response and hourly housekeeping, inside the API (D-36). */
@Global()
@Module({
  providers: [DeferredTasks, MaintenanceService, MonitoringService],
  exports: [DeferredTasks, MaintenanceService, MonitoringService],
})
export class RuntimeModule {}
