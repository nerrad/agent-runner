import type { FormEvent, ReactElement } from 'react';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type {
  JobArtifactId,
  JobArtifactPayload,
  JobSummaryArtifact,
  JobRecord,
  JobSpec,
  JobStatus,
} from '../shared/types.js';

const INITIAL_FORM: JobSpec = {
  repoUrl: '',
  ref: '',
  specPath: '',
  agentRuntime: 'claude',
  model: '',
  effort: 'auto',
  githubHost: 'github.com',
  commitOnStop: true,
  wpEnvEnabled: true,
  capabilityProfile: 'safe',
  repoAccessMode: 'none',
  agentStateMode: 'mounted',
};

const VIEWER_TABS = [
  { id: 'run', label: 'run.log' },
  { id: 'debug', label: 'debug.log' },
  { id: 'securityAudit', label: 'security audit' },
  { id: 'summary', label: 'summary' },
  { id: 'finalResponse', label: 'final response' },
  { id: 'gitDiff', label: 'git diff' },
  { id: 'transcript', label: 'transcript' },
  { id: 'prompt', label: 'prompt' },
  { id: 'agentStateSummary', label: 'agent-state summary' },
  { id: 'agentStateDiff', label: 'agent-state diff' },
] as const;

const TERMINAL_STATUSES = new Set<JobStatus>([ 'blocked', 'completed', 'failed', 'canceled' ]);
const ARTIFACT_POLL_INTERVAL_MS = 3000;
const COPY_FEEDBACK_TTL_MS = 2000;

type ViewerTabId = typeof VIEWER_TABS[number]['id'];

interface ArtifactState {
  loading: boolean;
  error: string | null;
  payload: JobArtifactPayload | null;
}

const INITIAL_ARTIFACT_STATE: ArtifactState = {
  loading: false,
  error: null,
  payload: null,
};

export function App(): ReactElement {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [viewerTab, setViewerTab] = useState<ViewerTabId>('run');
  const [logContent, setLogContent] = useState('');
  const [artifactState, setArtifactState] = useState<ArtifactState>(INITIAL_ARTIFACT_STATE);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [showRawFinalResponse, setShowRawFinalResponse] = useState(false);
  const [form, setForm] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logContentRef = useRef('');

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null,
    [jobs, selectedJobId],
  );
  const parsedFinalResponse = useMemo(
    () => parseFinalResponseContent(viewerTab === 'finalResponse' ? artifactState.payload?.content : undefined),
    [artifactState.payload?.content, viewerTab],
  );

  useEffect(() => {
    void refreshJobs();
    const interval = window.setInterval(() => {
      void refreshJobs();
    }, 5000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!copyFeedback) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setCopyFeedback(null);
    }, COPY_FEEDBACK_TTL_MS);

    return () => window.clearTimeout(timeout);
  }, [copyFeedback]);

  useEffect(() => {
    if (viewerTab === 'finalResponse') {
      setShowRawFinalResponse(false);
    }
  }, [viewerTab]);

  useEffect(() => {
    if (viewerTab === 'finalResponse' && parsedFinalResponse === null) {
      setShowRawFinalResponse(true);
    }
  }, [parsedFinalResponse, viewerTab]);

  useEffect(() => {
    if (!selectedJob || !isLiveLogTab(viewerTab)) {
      logContentRef.current = '';
      setLogContent('');
      return;
    }

    const logKind = viewerTab === 'debug' ? 'debug' : 'run';
    let closed = false;
    logContentRef.current = '';
    setLogContent('');

    const isDebug = logKind === 'debug';

    const replaceLog = (nextContent: string): void => {
      if (closed || nextContent === logContentRef.current) {
        return;
      }
      logContentRef.current = nextContent;
      const display = isDebug ? reverseLines(nextContent) : nextContent;
      startTransition(() => setLogContent(display));
    };

    const refreshLog = async (): Promise<void> => {
      const response = await fetch(`/api/jobs/${selectedJob.id}/logs?kind=${logKind}`);
      if (!response.ok || closed) {
        return;
      }

      replaceLog(await response.text());
    };

    void refreshLog();

    const source = new EventSource(`/api/jobs/${selectedJob.id}/logs?follow=1&kind=${logKind}`);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as {
        type?: string;
        chunk?: string;
        start?: number;
        end?: number;
        log?: {
          chunk?: string;
          start?: number;
          end?: number;
        };
      };

      if (payload.type === 'bootstrap') {
        replaceLog(payload.chunk ?? '');
        return;
      }

      const chunk = payload.log?.chunk ?? '';
      if (!chunk) {
        return;
      }

      const expectedStart = payload.log?.start ?? payload.start;
      if (typeof expectedStart === 'number' && expectedStart !== logContentRef.current.length) {
        void refreshLog();
        return;
      }

      const nextContent = logContentRef.current + chunk;
      const expectedEnd = payload.log?.end ?? payload.end;
      if (typeof expectedEnd === 'number' && expectedEnd !== nextContent.length) {
        void refreshLog();
        return;
      }

      logContentRef.current = nextContent;
      if (isDebug) {
        const reversed = reverseLines(chunk);
        startTransition(() => setLogContent((prev) => reversed + (prev ? '\n' + prev : '')));
      } else {
        startTransition(() => setLogContent(nextContent));
      }
    };

    return () => {
      closed = true;
      source.close();
    };
  }, [selectedJob?.id, viewerTab]);

  useEffect(() => {
    if (!selectedJob || isLiveLogTab(viewerTab)) {
      setArtifactState(INITIAL_ARTIFACT_STATE);
      return;
    }

    let canceled = false;
    let interval: number | undefined;

    const loadArtifact = async (initialLoad: boolean): Promise<void> => {
      if (initialLoad) {
        setArtifactState((current) => ({
          loading: true,
          error: null,
          payload: current.payload,
        }));
      }

      try {
        const response = await fetch(`/api/jobs/${selectedJob.id}/artifacts/${viewerTab}`);
        const payload = await response.json() as unknown;
        if (!response.ok) {
          const failure = payload as { error?: string };
          throw new Error(failure.error ?? `Failed to load ${viewerTabLabel(viewerTab)}`);
        }
        if (canceled) {
          return;
        }

        startTransition(() => {
          setArtifactState({
            loading: false,
            error: null,
            payload: payload as JobArtifactPayload,
          });
        });
      } catch (artifactError) {
        if (canceled) {
          return;
        }

        startTransition(() => {
          setArtifactState({
            loading: false,
            error: artifactError instanceof Error ? artifactError.message : `Failed to load ${viewerTabLabel(viewerTab)}`,
            payload: null,
          });
        });
      }
    };

    void loadArtifact(true);

    if (!TERMINAL_STATUSES.has(selectedJob.status)) {
      interval = window.setInterval(() => {
        void loadArtifact(false);
      }, ARTIFACT_POLL_INTERVAL_MS);
    }

    return () => {
      canceled = true;
      if (interval) {
        window.clearInterval(interval);
      }
    };
  }, [selectedJob?.id, selectedJob?.status, viewerTab]);

  async function refreshJobs(): Promise<void> {
    try {
      const response = await fetch('/api/jobs');
      const payload = await response.json() as unknown;
      if (!response.ok) {
        const failure = payload as { error?: string };
        throw new Error(failure.error ?? 'Failed to load jobs');
      }
      if (!Array.isArray(payload)) {
        throw new Error('Invalid jobs response');
      }

      const nextJobs = payload as JobRecord[];
      startTransition(() => {
        setJobs(nextJobs);
        if (!selectedJobId && nextJobs[0]) {
          setSelectedJobId(nextJobs[0].id);
        }
      });
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Failed to load jobs');
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const payload = {
        ...form,
        model: form.model || undefined,
        ref: form.ref || undefined,
        branch: form.branch || undefined,
      };

      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const failure = await response.json() as { error?: string };
        throw new Error(failure.error ?? 'Failed to create job');
      }

      const created = await response.json() as JobRecord;
      startTransition(() => {
        setForm(INITIAL_FORM);
        setSelectedJobId(created.id);
        setViewerTab('run');
      });
      await refreshJobs();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelSelectedJob(): Promise<void> {
    if (!selectedJob) {
      return;
    }
    await fetch(`/api/jobs/${selectedJob.id}/cancel`, { method: 'POST' });
    await refreshJobs();
  }

  async function copyArtifactCommand(command: string, successLabel: string): Promise<void> {
    try {
      if (!navigator.clipboard) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(command);
      setCopyFeedback(successLabel);
    } catch {
      setCopyFeedback('Clipboard copy failed');
    }
  }

  const artifactDir = selectedJob ? directoryPath(selectedJob.artifacts.logPath) : '';
  const artifactShellCommand = artifactDir ? `cd ${shellQuote(artifactDir)}` : '';

  return (
    <div className="page-shell">
      <div className="orb orb-a" />
      <div className="orb orb-b" />
      <header className="hero">
        <div>
          <p className="eyebrow">Local Autonomous Worker</p>
          <h1>agent-runner</h1>
          <p className="lede">
            Fresh repo clone, ephemeral worker container, brokered host access profiles, and a localhost control plane.
          </p>
        </div>
          <div className="hero-meta">
            <span>UI on 127.0.0.1</span>
            <span>Claude Code + Codex</span>
            <span>Profile-based host access</span>
          </div>
      </header>

      <main className="layout">
        <section className="panel form-panel">
          <div className="panel-header">
            <h2>New Job</h2>
            <p>Submit a repo and spec path. Agent OS spec directories are preferred; single-file plans still work.</p>
          </div>
          <form className="job-form" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              Repo URL
              <input
                value={form.repoUrl}
                onChange={(event) => setForm((current) => ({ ...current, repoUrl: event.target.value }))}
                placeholder="git@github.com:owner/repo.git"
                required
              />
            </label>
            <label>
              Ref / base branch
              <input
                value={form.ref ?? ''}
                onChange={(event) => setForm((current) => ({ ...current, ref: event.target.value }))}
                placeholder="main"
              />
            </label>
            <label>
              Branch name (optional)
              <input
                value={form.branch ?? ''}
                onChange={(event) => setForm((current) => ({ ...current, branch: event.target.value }))}
                placeholder="auto-generated if empty"
              />
            </label>
            <label>
              Spec path
              <input
                value={form.specPath}
                onChange={(event) => setForm((current) => ({ ...current, specPath: event.target.value }))}
                placeholder="agent-os/specs/feature-x"
                required
              />
            </label>
            <div className="inline-fields">
              <label>
                Agent runtime
                <select
                  value={form.agentRuntime}
                  onChange={(event) => setForm((current) => ({ ...current, agentRuntime: event.target.value as JobSpec['agentRuntime'] }))}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <label>
                Model
                <input
                  value={form.model ?? ''}
                  onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
                  placeholder="runtime default"
                />
              </label>
            </div>
            <div className="inline-fields">
              <label>
                Effort
                <select
                  value={form.effort}
                  onChange={(event) => setForm((current) => ({ ...current, effort: event.target.value as JobSpec['effort'] }))}
                >
                  <option value="auto">Auto</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label>
                GitHub host
                <input
                  value={form.githubHost}
                  onChange={(event) => setForm((current) => ({ ...current, githubHost: event.target.value as JobSpec['githubHost'] }))}
                  placeholder="github.com"
                />
              </label>
            </div>
            <div className="inline-fields">
              <label>
                Access profile
                <select
                  value={form.capabilityProfile}
                  onChange={(event) => setForm((current) => ({ ...current, capabilityProfile: event.target.value as JobSpec['capabilityProfile'] }))}
                >
                  <option value="safe">safe</option>
                  <option value="repo-broker">repo-broker</option>
                  <option value="docker-broker">docker-broker</option>
                  <option value="dangerous">dangerous</option>
                </select>
              </label>
              <label>
                Agent state
                <select
                  value={form.agentStateMode}
                  onChange={(event) => setForm((current) => ({ ...current, agentStateMode: event.target.value as JobSpec['agentStateMode'] }))}
                >
                  <option value="mounted">mounted</option>
                  <option value="none">none</option>
                </select>
              </label>
            </div>
            <div className="inline-fields">
              <label>
                Repo access
                <select
                  value={form.repoAccessMode}
                  onChange={(event) => setForm((current) => ({ ...current, repoAccessMode: event.target.value as JobSpec['repoAccessMode'] }))}
                >
                  <option value="none">none</option>
                  <option value="broker">broker</option>
                  <option value="ambient">ambient</option>
                </select>
              </label>
            </div>
            {form.capabilityProfile === 'dangerous' ? (
              <p className="error-line">Dangerous mode exposes ambient repo credentials and raw host Docker access.</p>
            ) : null}
            {form.agentStateMode === 'mounted' ? (
              <p className="error-line">Mounted agent state preserves local config, auth, instructions, telemetry, and cost/accounting state. It is mounted read-write and audited after the run, but the audit is forensic rather than preventive.</p>
            ) : null}
            {error ? <p className="error-line">{error}</p> : null}
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? 'Creating...' : 'Create Job'}
            </button>
          </form>
        </section>

        <section className="panel jobs-panel">
          <div className="panel-header">
            <h2>Jobs</h2>
            <p>One active job at a time. New jobs queue automatically.</p>
          </div>
          <div className="jobs-scroll">
            <div className="jobs-list">
              {jobs.map((job) => (
                <button
                  key={job.id}
                  type="button"
                  className={`job-card ${selectedJob?.id === job.id ? 'selected' : ''}`}
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <div className="job-card-head">
                    <span className={`status-pill status-${job.status}`}>{job.status}</span>
                    <span className="runtime-pill">{job.spec.agentRuntime}</span>
                  </div>
                  <strong>{job.spec.repoUrl}</strong>
                  <span>{job.spec.specPath}</span>
                  <span>{job.spec.model ?? 'runtime default'} / {job.spec.effort}</span>
                  <span>{job.spec.capabilityProfile} / {job.spec.agentStateMode}</span>
                  <span className="job-meta">{job.branchName}</span>
                </button>
              ))}
              {jobs.length === 0 ? <p className="empty-state">No jobs yet.</p> : null}
            </div>
          </div>
        </section>

        <section className="panel detail-panel">
          <div className="panel-header">
            <h2>Run Detail</h2>
            <p>Live logs, branch output, and local artifacts.</p>
          </div>
          {selectedJob ? (
            <div className="detail-grid">
              <div className="detail-stack">
                <div className="detail-card">
                  <div className="detail-topline">
                    <span className={`status-pill status-${selectedJob.status}`}>{selectedJob.status}</span>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void cancelSelectedJob()}
                      disabled={selectedJob.status !== 'running' && selectedJob.status !== 'queued' && selectedJob.status !== 'cloning' && selectedJob.status !== 'bootstrapping'}
                    >
                      Cancel
                    </button>
                  </div>
                  <dl>
                    <div>
                      <dt>Branch</dt>
                      <dd>{selectedJob.branchName}</dd>
                    </div>
                    <div>
                      <dt>HEAD</dt>
                      <dd>{selectedJob.headSha ?? 'pending'}</dd>
                    </div>
                    <div>
                      <dt>Model</dt>
                      <dd>{selectedJob.spec.model ?? 'runtime default'}</dd>
                    </div>
                    <div>
                      <dt>Effort</dt>
                      <dd>{selectedJob.spec.effort}</dd>
                    </div>
                    <div>
                      <dt>Profile</dt>
                      <dd>{selectedJob.spec.capabilityProfile}</dd>
                    </div>
                    <div>
                      <dt>Repo access</dt>
                      <dd>{selectedJob.spec.repoAccessMode}</dd>
                    </div>
                    <div>
                      <dt>Agent state</dt>
                      <dd>{selectedJob.spec.agentStateMode}</dd>
                    </div>
                    <div>
                      <dt>Agent-state warning</dt>
                      <dd>{selectedJob.spec.agentStateMode === 'mounted' ? 'Mounted host agent state is readable and writable by the worker' : 'Mounted host agent state disabled'}</dd>
                    </div>
                    <div>
                      <dt>Agent-state audit</dt>
                      <dd>{
                        selectedJob.agentStateModified === true
                          ? 'Changes detected'
                          : selectedJob.agentStateModified === false
                            ? 'No changes detected'
                            : 'Review summary or agent-state artifacts after completion'
                      }</dd>
                    </div>
                    <div>
                      <dt>Spec path</dt>
                      <dd>{selectedJob.spec.specPath}</dd>
                    </div>
                    <div>
                      <dt>Resolved spec</dt>
                      <dd>{selectedJob.resolvedSpec ? `${selectedJob.resolvedSpec.specMode}: ${selectedJob.resolvedSpec.specFiles.join(', ')}` : 'Pending'}</dd>
                    </div>
                    <div>
                      <dt>Spec source</dt>
                      <dd>{selectedJob.specSourceType ?? 'Pending'}</dd>
                    </div>
                    <div>
                      <dt>Workspace</dt>
                      <dd>{selectedJob.workspacePath}</dd>
                    </div>
                    <div>
                      <dt>Debug attach</dt>
                      <dd>{selectedJob.debugCommand ?? 'Available after container starts'}</dd>
                    </div>
                    <div>
                      <dt>Artifact dir</dt>
                      <dd className="artifact-location">
                        <code>{artifactDir}</code>
                        <div className="artifact-actions">
                          <button
                            type="button"
                            className="secondary-button slim-button"
                            onClick={() => void copyArtifactCommand(artifactDir, 'Copied artifact path')}
                          >
                            Copy path
                          </button>
                          <button
                            type="button"
                            className="secondary-button slim-button"
                            onClick={() => void copyArtifactCommand(artifactShellCommand, 'Copied cd command')}
                          >
                            Copy cd
                          </button>
                        </div>
                        <span className="artifact-command">{artifactShellCommand}</span>
                        {copyFeedback ? <span className="copy-feedback">{copyFeedback}</span> : null}
                      </dd>
                    </div>
                    <div>
                      <dt>Artifacts</dt>
                      <dd className="artifact-links">
                        {VIEWER_TABS.map((tab) => renderViewerLink(tab.label, tab.id, viewerTab, setViewerTab))}
                      </dd>
                    </div>
                    {selectedJob.blockerReason ? (
                      <div>
                        <dt>Blocker</dt>
                        <dd>{selectedJob.blockerReason}</dd>
                      </div>
                    ) : null}
                  </dl>
                </div>
              </div>

              <div className="log-shell">
                <div className="log-header">
                  <div className="log-header-main">
                    <span>{viewerTabLabel(viewerTab)}</span>
                    <div className="log-toggle" role="tablist" aria-label="Viewer tab">
                      {VIEWER_TABS.map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          className={viewerTab === tab.id ? 'active' : ''}
                          onClick={() => setViewerTab(tab.id)}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <span className="viewer-status">{viewerStatusLabel(selectedJob.status, viewerTab)}</span>
                </div>
                {renderViewerBody(
                  viewerTab,
                  logContent,
                  artifactState,
                  parsedFinalResponse,
                  showRawFinalResponse,
                  setShowRawFinalResponse,
                )}
              </div>
            </div>
          ) : (
            <p className="empty-state">Select a job to inspect its run state.</p>
          )}
        </section>
      </main>
    </div>
  );
}

function renderViewerLink(
  label: string,
  tab: ViewerTabId,
  activeTab: ViewerTabId,
  onSelect: (tab: ViewerTabId) => void,
): ReactElement {
  return (
    <button
      key={tab}
      type="button"
      className={`artifact-link ${activeTab === tab ? 'active' : ''}`}
      onClick={() => onSelect(tab)}
    >
      {label}
    </button>
  );
}

function renderViewerBody(
  viewerTab: ViewerTabId,
  logContent: string,
  artifactState: ArtifactState,
  parsedFinalResponse: ParsedFinalResponse | null,
  showRawFinalResponse: boolean,
  setShowRawFinalResponse: (next: boolean) => void,
): ReactElement {
  if (isLiveLogTab(viewerTab)) {
    return (
      <pre>{logContent || (viewerTab === 'debug' ? 'Waiting for debug output...' : 'Waiting for output...')}</pre>
    );
  }

  if (artifactState.loading && !artifactState.payload) {
    return <pre>Loading {viewerTabLabel(viewerTab)}...</pre>;
  }

  if (artifactState.error) {
    return <pre>{artifactState.error}</pre>;
  }

  if (!artifactState.payload) {
    return <pre>Select an artifact to inspect it.</pre>;
  }

  if (viewerTab === 'summary' && artifactState.payload.summary) {
    return renderSummaryArtifact(artifactState.payload.summary);
  }

  if (viewerTab === 'finalResponse') {
    return renderFinalResponseArtifact(artifactState.payload, parsedFinalResponse, showRawFinalResponse, setShowRawFinalResponse);
  }

  return (
    <pre>{artifactText(viewerTab, artifactState.payload)}</pre>
  );
}

function renderSummaryArtifact(summary: JobSummaryArtifact): ReactElement {
  return (
    <div className="summary-view">
      <div className="summary-topline">
        <span className={`status-pill status-${summary.status}`}>{summary.status}</span>
        <span>{summary.finishedAt}</span>
      </div>
      <div className="summary-copy">
        {renderMarkdownishText(summary.summary ?? 'The agent did not return a summary string for this job.')}
      </div>
      <dl className="summary-grid">
        <div>
          <dt>Branch</dt>
          <dd>{summary.branchName}</dd>
        </div>
        <div>
          <dt>HEAD</dt>
          <dd>{summary.headSha ?? 'pending'}</dd>
        </div>
        <div>
          <dt>Spec path</dt>
          <dd>{summary.specPath}</dd>
        </div>
        <div>
          <dt>Source spec</dt>
          <dd>{summary.sourceSpecPath}</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>{summary.workspacePath}</dd>
        </div>
        <div>
          <dt>Debug attach</dt>
          <dd>{summary.debugCommand ?? 'Not available'}</dd>
        </div>
        {summary.blockerReason ? (
          <div>
            <dt>Blocker</dt>
            <dd>{summary.blockerReason}</dd>
          </div>
        ) : null}
      </dl>
      <div className="summary-section">
        <h3>Changed files</h3>
        {summary.changedFiles.length > 0 ? (
          <ul className="summary-files">
            {summary.changedFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">No file changes captured.</p>
        )}
      </div>
    </div>
  );
}

function artifactText(viewerTab: JobArtifactId, payload: JobArtifactPayload): string {
  if (!payload.available) {
    if (viewerTab === 'securityAudit') {
      return 'No blocked activity was recorded for this job.';
    }
    return `${payload.label} is not available yet.`;
  }

  if (payload.content.trim().length > 0) {
    return payload.content;
  }

  switch (viewerTab) {
    case 'gitDiff':
      return 'No git diff captured for this job.';
    case 'summary':
      return 'No summary captured for this job.';
    case 'transcript':
      return 'No transcript captured for this job.';
    case 'securityAudit':
      return 'No blocked activity was recorded for this job.';
    case 'finalResponse':
      return 'No final response artifact captured for this job.';
    case 'prompt':
      return 'No prompt artifact captured for this job.';
    case 'agentStateSummary':
      return 'No agent-state summary captured for this job.';
    case 'agentStateDiff':
      return 'No agent-state diff captured for this job.';
  }
}

function isLiveLogTab(viewerTab: ViewerTabId): viewerTab is 'run' | 'debug' {
  return viewerTab === 'run' || viewerTab === 'debug';
}

function viewerTabLabel(viewerTab: ViewerTabId): string {
  switch (viewerTab) {
    case 'run':
      return 'Run log';
    case 'debug':
      return 'Debug log';
    case 'summary':
      return 'Summary';
    case 'securityAudit':
      return 'Security audit log';
    case 'finalResponse':
      return 'Final response';
    case 'gitDiff':
      return 'Git diff';
    case 'transcript':
      return 'Transcript';
    case 'prompt':
      return 'Prompt';
    case 'agentStateSummary':
      return 'Agent-state summary';
    case 'agentStateDiff':
      return 'Agent-state diff';
  }
}

function viewerStatusLabel(status: JobStatus, viewerTab: ViewerTabId): string {
  if (isLiveLogTab(viewerTab)) {
    return 'live stream';
  }

  return TERMINAL_STATUSES.has(status) ? 'stored locally' : 'polling artifacts';
}

function directoryPath(absolutePath: string): string {
  const lastSlash = absolutePath.lastIndexOf('/');
  return lastSlash >= 0 ? absolutePath.slice(0, lastSlash) : absolutePath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', `'\"'\"'`)}'`;
}

function prettifyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

interface ParsedFinalResponse {
  primary: {
    status?: string;
    summary?: string;
    blockerReason?: string | null;
  };
  primarySource: Record<string, unknown>;
  metadata: Array<[string, unknown]>;
  raw: string;
}

function renderFinalResponseArtifact(
  payload: JobArtifactPayload,
  parsed: ParsedFinalResponse | null,
  showRaw: boolean,
  setShowRaw: (next: boolean) => void,
): ReactElement {
  const rawContent = payload.content.trim().length > 0 ? prettifyJson(payload.content) : artifactText('finalResponse', payload);
  const parsedContent = parsed;

  return (
    <div className="final-response-view">
      <div className="viewer-subtoggle" role="tablist" aria-label="Final response view">
        <button
          type="button"
          className={!showRaw ? 'active' : ''}
          onClick={() => setShowRaw(false)}
          disabled={parsed === null}
        >
          Parsed
        </button>
        <button
          type="button"
          className={showRaw ? 'active' : ''}
          onClick={() => setShowRaw(true)}
        >
          Raw
        </button>
      </div>

      {parsed === null ? (
        <p className="viewer-note">Parsed view unavailable because this artifact is not valid JSON.</p>
      ) : null}

      {showRaw || parsedContent === null ? (
        <pre>{rawContent}</pre>
      ) : (
        <div className="final-response-card">
          <div className="summary-topline">
            <span className={`status-pill status-${parsedContent.primary.status ?? 'completed'}`}>{parsedContent.primary.status ?? 'unknown'}</span>
          </div>
          <div className="summary-section">
            <h3>Summary</h3>
            <div className="summary-copy">
              {renderMarkdownishText(parsedContent.primary.summary ?? 'No summary field present.')}
            </div>
          </div>
          <dl className="summary-grid">
            <div>
              <dt>Blocker</dt>
              <dd>{parsedContent.primary.blockerReason ?? 'None'}</dd>
            </div>
          </dl>
          {parsedContent.metadata.length > 0 ? (
            <div className="summary-section">
              <h3>Metadata</h3>
              <dl className="summary-grid">
                {parsedContent.metadata.map(([ key, value ]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{renderMetadataValue(key, value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function parseFinalResponseContent(content?: string): ParsedFinalResponse | null {
  if (!content || content.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const topLevel = parsed as Record<string, unknown>;
    const primarySource = (
      topLevel.structured_output && typeof topLevel.structured_output === 'object' && !Array.isArray(topLevel.structured_output)
        ? topLevel.structured_output
        : topLevel
    ) as Record<string, unknown>;

    const metadata = Object.entries(topLevel).filter(([ key ]) => {
      if (key === 'structured_output') {
        return false;
      }

      if (!('structured_output' in topLevel)) {
        return key !== 'status' && key !== 'summary' && key !== 'blockerReason';
      }

      return true;
    });

    return {
      primary: {
        status: typeof primarySource.status === 'string' ? primarySource.status : undefined,
        summary: typeof primarySource.summary === 'string' ? primarySource.summary : undefined,
        blockerReason:
          typeof primarySource.blockerReason === 'string' || primarySource.blockerReason === null
            ? (primarySource.blockerReason as string | null | undefined)
            : undefined,
      },
      primarySource,
      metadata,
      raw: content,
    };
  } catch {
    return null;
  }
}

function renderMetadataValue(key: string, value: unknown): ReactElement {
  const normalizedKey = normalizeMetadataKey(key);
  const normalizedValue = coerceStructuredValue(value);

  if (normalizedKey === 'permission denials') {
    const entries = Array.isArray(normalizedValue)
      ? normalizedValue.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];

    return (
      <span>{entries.length > 0 ? entries.join(', ') : 'None'}</span>
    );
  }

  if (normalizedKey === 'usage' || normalizedKey === 'model usage') {
    return renderStructuredKeyValue(normalizedValue);
  }

  return renderStructuredMetadata(normalizedValue);
}

function renderStructuredMetadata(value: unknown): ReactElement {
  if (typeof value === 'string') {
    return <span className="metadata-copy">{value}</span>;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span>{String(value)}</span>;
  }

  if (value === null) {
    return <span>None</span>;
  }

  if (Array.isArray(value)) {
    const entries = value.map((entry) => stringifyMetadataValue(entry)).filter(Boolean);
    return <span className="metadata-copy">{entries.length > 0 ? entries.join(', ') : 'None'}</span>;
  }

  if (value && typeof value === 'object') {
    return renderStructuredKeyValue(value);
  }

  return <span>{String(value)}</span>;
}

function renderStructuredKeyValue(value: unknown): ReactElement {
  if (typeof value === 'string') {
    const rows = parseUsageRows(value);
    if (rows.length > 0) {
      return (
        <dl className="kv-list">
          {rows.map(([ usageKey, usageValue ]) => (
            <div key={usageKey}>
              <dt>{humanizeMetadataLabel(usageKey)}</dt>
              <dd>{renderStructuredMetadata(coerceStructuredValue(usageValue))}</dd>
            </div>
          ))}
        </dl>
      );
    }

    return <span className="metadata-copy">{value}</span>;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return renderStructuredMetadata(value);
  }

  const rows = Object.entries(value as Record<string, unknown>);
  return (
    <dl className="kv-list">
      {rows.map(([ nestedKey, nestedValue ]) => (
        <div key={nestedKey}>
          <dt>{humanizeMetadataLabel(nestedKey)}</dt>
          <dd>{renderStructuredMetadata(coerceStructuredValue(nestedValue))}</dd>
        </div>
      ))}
    </dl>
  );
}

function parseUsageRows(value: unknown): Array<[string, unknown]> {
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const delimiterIndex = line.indexOf(':');
        if (delimiterIndex === -1) {
          return [ line, '' ] as [string, unknown];
        }

        return [
          line.slice(0, delimiterIndex).trim(),
          line.slice(delimiterIndex + 1).trim(),
        ] as [string, unknown];
      });
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>);
  }

  return [];
}

function normalizeMetadataKey(key: string): string {
  const spaced = key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();

  if (spaced === 'modelusage') {
    return 'model usage';
  }

  if (spaced === 'permissiondenials') {
    return 'permission denials';
  }

  return spaced;
}

function humanizeMetadataLabel(key: string): string {
  return normalizeMetadataKey(key).replace(/\b\w/g, (match) => match.toUpperCase());
}

function coerceStructuredValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function stringifyMetadataValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value === null) {
    return 'null';
  }

  return JSON.stringify(value);
}

function reverseLines(content: string): string {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  lines.reverse();
  return lines.join('\n');
}

function renderMarkdownishText(content: string): ReactElement {
  const blocks = content.replaceAll('\r\n', '\n').split('\n\n');

  return (
    <div className="markdownish">
      {blocks.map((block, index) => renderMarkdownishBlock(block, index))}
    </div>
  );
}

function renderMarkdownishBlock(block: string, index: number): ReactElement {
  const lines = block.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);

  if (lines.every((line) => /^[-*]\s+/.test(line))) {
    return (
      <ul key={index} className="markdownish-list">
        {lines.map((line, lineIndex) => (
          <li key={`${index}-${lineIndex}`}>{renderInlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>
        ))}
      </ul>
    );
  }

  if (lines.every((line) => /^\d+\.\s+/.test(line))) {
    return (
      <ol key={index} className="markdownish-list">
        {lines.map((line, lineIndex) => (
          <li key={`${index}-${lineIndex}`}>{renderInlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>
        ))}
      </ol>
    );
  }

  return (
    <p key={index}>
      {lines.map((line, lineIndex) => (
        <span key={`${index}-${lineIndex}`}>
          {renderInlineMarkdown(line)}
          {lineIndex < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </p>
  );
}

function renderInlineMarkdown(content: string): Array<ReactElement | string> {
  const parts = content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }

    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }

    return part;
  });
}
