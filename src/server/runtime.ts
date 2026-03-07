import type { RuntimeConfig } from './config.js';
import { AgentAdapters } from './agent-adapters.js';
import { DockerRunner } from './docker-runner.js';
import { GitManager } from './git-manager.js';
import { JobEvents } from './job-events.js';
import { JobManager, type JobManagerOptions } from './job-manager.js';
import { JobStore } from './job-store.js';

export interface RuntimeContext {
  config: RuntimeConfig;
  events: JobEvents;
  store: JobStore;
  git: GitManager;
  docker: DockerRunner;
  adapters: AgentAdapters;
  manager: JobManager;
}

export function createRuntime(config: RuntimeConfig, options: JobManagerOptions = {}): RuntimeContext {
  const events = new JobEvents();
  const store = new JobStore(config);
  const git = new GitManager();
  const docker = new DockerRunner(config);
  const adapters = new AgentAdapters();
  const manager = new JobManager(config, store, events, git, docker, adapters, options);

  return {
    config,
    events,
    store,
    git,
    docker,
    adapters,
    manager,
  };
}
