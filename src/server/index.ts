import path from 'node:path';
import { AccountService } from './account-service';
import { createApp } from './app';
import { ConfigStore } from './config';
import { JobManager } from './job-manager';
import { JobStore } from './job-store';

const projectRoot = process.cwd();
const configStore = new ConfigStore(projectRoot);
const jobStore = new JobStore(configStore.get().runtimeDirectory);
jobStore.initialize();
const accountService = new AccountService(projectRoot, configStore);
const jobManager = new JobManager(projectRoot, accountService, configStore, jobStore);
const lockModule = require(path.join(projectRoot, 'automation-lock.js')) as {
  readAutomationLock(runtimeDirectory?: string): { status: 'free' | 'busy' | 'stale' };
};

const app = createApp({
  projectRoot,
  configStore,
  accountService,
  jobStore,
  jobManager,
  lockReader: () => lockModule.readAutomationLock(configStore.get().runtimeDirectory),
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
