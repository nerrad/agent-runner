import { z } from 'zod';

export const AgentRuntimeSchema = z.enum([ 'claude', 'codex' ]);
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

export const AgentEffortSchema = z.enum([ 'auto', 'low', 'medium', 'high' ]);
export type AgentEffort = z.infer<typeof AgentEffortSchema>;

export const GitHubHostSchema = z.string().min(1);
export type GitHubHost = z.infer<typeof GitHubHostSchema>;

export const JobStatusSchema = z.enum([
  'queued',
  'cloning',
  'bootstrapping',
  'running',
  'blocked',
  'completed',
  'failed',
  'canceled',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSpecSchema = z.object({
  repoUrl: z.string().min(1),
  ref: z.string().min(1).optional(),
  specPath: z.string().min(1),
  agentRuntime: AgentRuntimeSchema,
  model: z.string().min(1).optional(),
  effort: AgentEffortSchema.default('auto'),
  githubHost: GitHubHostSchema,
  commitOnStop: z.literal(true).default(true),
  wpEnvEnabled: z.literal(true).default(true),
});
export type JobSpec = z.infer<typeof JobSpecSchema>;

export const ResolvedSpecSchema = z.object({
  specMode: z.enum([ 'bundle', 'file' ]),
  specEntryPath: z.string().min(1),
  specFiles: z.array(z.string().min(1)).min(1),
  visualsDir: z.string().min(1).optional(),
});
export type ResolvedSpec = z.infer<typeof ResolvedSpecSchema>;

export const GitHostProfileSchema = z.object({
  host: GitHubHostSchema,
  ghConfigMountPath: z.string().min(1),
  sshAgentForward: z.literal(true),
  proxyUrl: z.string().min(1).optional(),
});
export type GitHostProfile = z.infer<typeof GitHostProfileSchema>;

export const ArtifactBundleSchema = z.object({
  logPath: z.string().min(1),
  summaryPath: z.string().min(1),
  testResultsPath: z.string().min(1).optional(),
  gitDiffPath: z.string().min(1),
  agentTranscriptPath: z.string().min(1),
  finalResponsePath: z.string().min(1),
  schemaPath: z.string().min(1),
  promptPath: z.string().min(1),
  specBundlePath: z.string().min(1),
});
export type ArtifactBundle = z.infer<typeof ArtifactBundleSchema>;

export const JobRecordSchema = z.object({
  id: z.string().min(1),
  spec: JobSpecSchema,
  status: JobStatusSchema,
  workspacePath: z.string().min(1),
  containerId: z.string().optional(),
  branchName: z.string().min(1),
  headSha: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  blockerReason: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  artifacts: ArtifactBundleSchema,
  resolvedSpec: ResolvedSpecSchema.optional(),
  debugCommand: z.string().optional(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export const AgentResultSchema = z.object({
  status: z.enum([ 'completed', 'blocked' ]),
  summary: z.string().min(1),
  blockerReason: z.string().nullable().optional(),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

export const JobLogEventSchema = z.object({
  jobId: z.string().min(1),
  chunk: z.string(),
  at: z.string(),
});
export type JobLogEvent = z.infer<typeof JobLogEventSchema>;

export const JobEventSchema = z.object({
  type: z.enum([ 'record', 'log' ]),
  record: JobRecordSchema.optional(),
  log: JobLogEventSchema.optional(),
});
export type JobEvent = z.infer<typeof JobEventSchema>;
