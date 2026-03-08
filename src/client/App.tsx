import type { FormEvent, ReactElement } from 'react';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type {
  JobArtifactId,
  JobArtifactPayload,
  JobSummaryArtifact,
  JobRecord,
  JobSpec,
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
};

const VIEWER_TABS = [
  { id: 'run', label: 'run.log' },
  { id: 'debug', label: 'debug.log' },
  { id: 'summary', label: 'summary' },
  { id: 'gitDiff', label: 'git diff' },
  { id: 'transcript', label: 'transcript' },
] as const;

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
  const [form, setForm] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logContentRef = useRef('');

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null,
    [jobs, selectedJobId],
  );

  useEffect(() => {
    void refreshJobs();
    const interval = window.setInterval(() => {
      void refreshJobs();
    }, 5000);

    return () => window.clearInterval(interval);
  }, []);

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

    const replaceLog = (nextContent: string): void => {
      if (closed || nextContent === logContentRef.current) {
        return;
      }
      logContentRef.current = nextContent;
      startTransition(() => setLogContent(nextContent));
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
      startTransition(() => setLogContent(nextContent));
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
    setArtifactState({
      loading: true,
      error: null,
      payload: null,
    });

    void (async () => {
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
    })();

    return () => {
      canceled = true;
    };
  }, [selectedJob?.id, viewerTab]);

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

  return (
    <div className="page-shell">
      <div className="orb orb-a" />
      <div className="orb orb-b" />
      <header className="hero">
        <div>
          <p className="eyebrow">Local Autonomous Worker</p>
          <h1>agent-runner</h1>
          <p className="lede">
            Fresh repo clone, ephemeral worker container, one active job, and a localhost control plane.
          </p>
        </div>
        <div className="hero-meta">
          <span>127.0.0.1 only</span>
          <span>Claude Code + Codex</span>
          <span>Docker socket passthrough</span>
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
            <p>Live logs, branch output, and local debug access.</p>
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
                      <dt>Spec path</dt>
                      <dd>{selectedJob.spec.specPath}</dd>
                    </div>
                    <div>
                      <dt>Resolved spec</dt>
                      <dd>{selectedJob.resolvedSpec ? `${selectedJob.resolvedSpec.specMode}: ${selectedJob.resolvedSpec.specFiles.join(', ')}` : 'Pending'}</dd>
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
                      <dt>Artifacts</dt>
                      <dd className="artifact-links">
                        {renderViewerLink('run log', 'run', viewerTab, setViewerTab)}
                        {renderViewerLink('debug log', 'debug', viewerTab, setViewerTab)}
                        {renderViewerLink('summary', 'summary', viewerTab, setViewerTab)}
                        {renderViewerLink('git diff', 'gitDiff', viewerTab, setViewerTab)}
                        {renderViewerLink('transcript', 'transcript', viewerTab, setViewerTab)}
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
                  <span>{isLiveLogTab(viewerTab) ? 'live' : 'artifact'}</span>
                </div>
                {renderViewerBody(viewerTab, logContent, artifactState)}
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
      type="button"
      className={`artifact-link ${activeTab === tab ? 'active' : ''}`}
      onClick={() => onSelect(tab)}
    >
      {label}
    </button>
  );
}

function renderViewerBody(viewerTab: ViewerTabId, logContent: string, artifactState: ArtifactState): ReactElement {
  if (isLiveLogTab(viewerTab)) {
    return (
      <pre>{logContent || (viewerTab === 'debug' ? 'Waiting for debug output...' : 'Waiting for output...')}</pre>
    );
  }

  if (artifactState.loading) {
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
      <p className="summary-copy">{summary.summary ?? 'No agent summary captured.'}</p>
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
    case 'gitDiff':
      return 'Git diff';
    case 'transcript':
      return 'Transcript';
  }
}
