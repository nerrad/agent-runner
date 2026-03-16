import type { RuntimeConfig } from './config.js';
import { AgentStateAuditor } from './agent-state-audit.js';
import { AgentAdapters } from './agent-adapters.js';
import { BrokerLeaseStore } from './broker-lease.js';
import { DockerBroker } from './docker-broker.js';
import { DockerRunner } from './docker-runner.js';
import { GitManager } from './git-manager.js';
import { JobEvents } from './job-events.js';
import { JobManager, type JobManagerOptions } from './job-manager.js';
import { JobStore } from './job-store.js';
import { RepoBroker } from './repo-broker.js';
import { SecurityAuditLogger } from './security-audit-log.js';

export interface RuntimeContext {
  config: RuntimeConfig;
  events: JobEvents;
  store: JobStore;
  git: GitManager;
  docker: DockerRunner;
  adapters: AgentAdapters;
  agentStateAuditor: AgentStateAuditor;
  brokerLeaseStore: BrokerLeaseStore;
  repoBroker: RepoBroker;
  dockerBroker: DockerBroker;
  securityAuditLogger: SecurityAuditLogger;
  manager: JobManager;
}

export function createRuntime(config: RuntimeConfig, options: JobManagerOptions = {}): RuntimeContext {
  const events = new JobEvents();
  const store = new JobStore(config);
  const git = new GitManager();
  const docker = new DockerRunner(config);
  const adapters = new AgentAdapters();
  const agentStateAuditor = new AgentStateAuditor(config);
  const brokerLeaseStore = new BrokerLeaseStore(config);
  const repoBroker = new RepoBroker(config);
  const dockerBroker = new DockerBroker(config);
  const securityAuditLogger = new SecurityAuditLogger();
  const manager = new JobManager(
    config,
    store,
    events,
    git,
    docker,
    adapters,
    agentStateAuditor,
    brokerLeaseStore,
    dockerBroker,
    securityAuditLogger,
    options,
  );

  return {
    config,
    events,
    store,
    git,
    docker,
    adapters,
    agentStateAuditor,
    brokerLeaseStore,
    repoBroker,
    dockerBroker,
    securityAuditLogger,
    manager,
  };
}
