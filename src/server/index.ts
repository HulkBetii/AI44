import path from 'node:path';
import { AccountService } from './account-service';
import { createApp } from './app';
import { ConfigStore } from './config';
import { JobManager } from './job-manager';
import { JobStore } from './job-store';
import { acquireAutomationMaintenanceGuard } from './lock-guard';
import { RecoveryService } from './recovery';

const projectRoot = process.cwd();
const configStore = new ConfigStore(projectRoot);
const jobStore = new JobStore(configStore.get().runtimeDirectory);
jobStore.initialize();
const accountService = new AccountService(projectRoot, configStore);
const recoveryService = new RecoveryService(projectRoot, configStore, accountService);
const lockModule = require(path.join(projectRoot, 'automation-lock.js')) as {
  readAutomationLock(runtimeDirectory?: string): { status: 'free' | 'busy' | 'stale' };
  maintenanceLockPath(runtimeDirectory?: string): string;
};
const gpmModule = require(path.join(projectRoot, 'gpm-api.js')) as {
  assertNoUncertainCreates(options: { runtimeDirectory: string }): void;
};
const jobManager = new JobManager(
  projectRoot,
  accountService,
  configStore,
  jobStore,
  recoveryService,
  (runtimeDirectory) => lockModule.readAutomationLock(runtimeDirectory),
  (runtimeDirectory) => gpmModule.assertNoUncertainCreates({ runtimeDirectory }),
  (runtimeDirectory) => acquireAutomationMaintenanceGuard(lockModule, runtimeDirectory, 'ui-job-recovery'),
);
void (async () => {
  let releaseGuard: (() => void) | undefined;
  try {
    const runtimeDirectory = configStore.get().runtimeDirectory;
    releaseGuard = acquireAutomationMaintenanceGuard(lockModule, runtimeDirectory, 'ui-console-startup');
    await recoveryService.reconcileConfirmed();
  } catch (error) {
    console.error(`Recovery sync skipped at startup: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    releaseGuard?.();
  }
})();

const app = createApp({
  projectRoot,
  configStore,
  accountService,
  jobStore,
  jobManager,
  recoveryService,
  lockReader: (runtimeDirectory) => lockModule.readAutomationLock(runtimeDirectory || configStore.get().runtimeDirectory),
  lockGuardAcquirer: (runtimeDirectory) => acquireAutomationMaintenanceGuard(lockModule, runtimeDirectory, 'ui-console'),
  automationAdmissionGuard: (runtimeDirectory) => gpmModule.assertNoUncertainCreates({ runtimeDirectory }),
});

const port = Number(process.env.PORT || 4317);
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Mail Automation Console: http://127.0.0.1:${port}`);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal}: stopping active automation safely...`);
    await jobManager.shutdown().catch((error) => console.error(`Worker shutdown failed: ${error.message}`));
    server.close(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    server.closeAllConnections();
  });
}
