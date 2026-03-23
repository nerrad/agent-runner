#!/usr/bin/env node
import process from 'node:process';
import { ensureBrokerService } from './broker-service.js';
import { loadRuntimeConfig } from './config.js';
import { parseCliArgs, normalizeRunSpec, formatJobSummary, helpText, defaultSkillTargets, resolveSkillTargetRoot } from './cli-utils.js';
import { runInit } from './init.js';
import { createRuntime } from './runtime.js';
import { installSkills } from './skill-installer.js';

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));
  const config = await loadRuntimeConfig();
  // For internal-run, provide ensureBroker so the broker is started inside
  // the job lock — not before it — preventing a stale-broker race when
  // multiple jobs are queued concurrently.
  // eslint-disable-next-line prefer-const -- closure must capture the binding before assignment
  let runtime: ReturnType<typeof createRuntime>;
  runtime = createRuntime(config, command.command === 'internal-run' ? {
    runMode: 'inline' as const,
    ensureBroker: () => ensureBrokerService(runtime),
  } : {});

  switch (command.command) {
    case 'init': {
      const result = await runInit(config);
      process.stdout.write(`Saved ${result.savedKeys.length === 0 ? 'no keys' : result.savedKeys.join(', ')} to ${result.envPath}\n`);
      return;
    }
    case 'run': {
      await runtime.manager.cleanupOrphanedDockerResources();
      const normalized = await normalizeRunSpec(command, config, runtime.git);
      const record = await runtime.manager.createJob(normalized.jobSpec);
      process.stdout.write(`${record.id}\n`);
      if (!command.detach) {
        await followLogs(runtime.manager, record.id);
      }
      return;
    }
    case 'list': {
      const jobs = await runtime.manager.listJobs();
      if (jobs.length === 0) {
        process.stdout.write('No jobs found.\n');
        return;
      }
      process.stdout.write(`${jobs.map((job) => formatJobSummary(job)).join('\n\n')}\n`);
      return;
    }
    case 'show': {
      const job = await runtime.manager.getJob(command.jobId);
      if (!job) {
        throw new Error(`Job not found: ${command.jobId}`);
      }
      process.stdout.write(`${formatJobSummary(job)}\n`);
      if (job.debugCommand) {
        process.stdout.write(`debug=${job.debugCommand}\n`);
      }
      return;
    }
    case 'logs': {
      await followLogs(runtime.manager, command.jobId, { follow: command.follow, kind: command.kind });
      return;
    }
    case 'cancel': {
      const job = await runtime.manager.cancelJob(command.jobId);
      if (!job) {
        throw new Error(`Job not found: ${command.jobId}`);
      }
      process.stdout.write(`${formatJobSummary(job)}\n`);
      return;
    }
    case 'skills-install': {
      const installed = await installSkills(
        config,
        resolveSkillTargetRoot,
        {
          force: command.force,
          targets: defaultSkillTargets(command.claudeOnly, command.codexOnly),
        },
      );
      process.stdout.write(`${installed.map((item) => `${item.target}: ${item.destination}`).join('\n')}\n`);
      return;
    }
    case 'internal-run': {
      await runtime.manager.cleanupOrphanedDockerResources();
      await runtime.manager.runJob(command.jobId);
      return;
    }
    default:
      process.stdout.write(`${helpText()}\n`);
  }
}

async function followLogs(
  manager: ReturnType<typeof createRuntime>['manager'],
  jobId: string,
  options: { follow?: boolean; kind?: 'run' | 'debug' } = { follow: true, kind: 'run' },
): Promise<void> {
  let printedLength = 0;

  for (;;) {
    const job = await manager.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const log = await manager.readLog(jobId, options.kind);
    if (log.length > printedLength) {
      process.stdout.write(log.slice(printedLength));
      printedLength = log.length;
    }

    const done = [ 'blocked', 'completed', 'failed', 'canceled' ].includes(job.status);
    if (!options.follow || done) {
      if (done) {
        process.stdout.write(`\n${formatJobSummary(job)}\n`);
      }
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stderr.write(`${helpText()}\n`);
  process.exitCode = 1;
});
