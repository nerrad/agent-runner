import path from 'node:path';
import type { ArtifactBundle } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';

export interface JobPaths {
  jobDir: string;
  workspacePath: string;
  artifactDir: string;
  recordPath: string;
  artifacts: ArtifactBundle;
}

export function buildJobPaths(config: RuntimeConfig, jobId: string): JobPaths {
  const jobDir = path.join(config.jobsDir, jobId);
  const artifactDir = path.join(config.artifactsDir, jobId);
  return {
    jobDir,
    workspacePath: path.join(config.workspacesDir, jobId, 'repo'),
    artifactDir,
    recordPath: path.join(jobDir, 'job.json'),
    artifacts: {
      logPath: path.join(artifactDir, 'run.log'),
      summaryPath: path.join(artifactDir, 'summary.json'),
      gitDiffPath: path.join(artifactDir, 'git.diff'),
      agentTranscriptPath: path.join(artifactDir, 'agent-transcript.log'),
      finalResponsePath: path.join(artifactDir, 'final-response.json'),
      schemaPath: path.join(artifactDir, 'result-schema.json'),
      promptPath: path.join(artifactDir, 'prompt.txt'),
      specBundlePath: path.join(artifactDir, 'spec'),
    },
  };
}
