import type { FormEvent, ReactElement } from 'react';
import { startTransition, useEffect, useMemo, useState } from 'react';
import type { JobRecord, JobSpec } from '../shared/types.js';

const INITIAL_FORM: JobSpec = {
  repoUrl: '',
  ref: '',
  specPath: '',
  agentRuntime: 'claude',
  githubHost: 'github.com',
  commitOnStop: true,
  wpEnvEnabled: true,
};

export function App(): ReactElement {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [logContent, setLogContent] = useState('');
  const [form, setForm] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!selectedJob) {
      setLogContent('');
      return;
    }

    let closed = false;
    setLogContent('');

    void fetch(`/api/jobs/${selectedJob.id}/logs`)
      .then((response) => response.text())
      .then((text) => {
        if (!closed) {
          startTransition(() => setLogContent(text));
        }
      });

    const source = new EventSource(`/api/jobs/${selectedJob.id}/logs?follow=1`);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as {
        type?: string;
        chunk?: string;
        log?: { chunk: string };
      };

      const chunk = payload.type === 'bootstrap'
        ? payload.chunk ?? ''
        : payload.log?.chunk ?? '';

      if (!chunk) {
        return;
      }

      startTransition(() => {
        setLogContent((current) => current + chunk);
      });
    };

    return () => {
      closed = true;
      source.close();
    };
  }, [selectedJob?.id]);

  async function refreshJobs(): Promise<void> {
    const response = await fetch('/api/jobs');
    const nextJobs = await response.json() as JobRecord[];
    startTransition(() => {
      setJobs(nextJobs);
      if (!selectedJobId && nextJobs[0]) {
        setSelectedJobId(nextJobs[0].id);
      }
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const payload = {
        ...form,
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
                GitHub host
                <select
                  value={form.githubHost}
                  onChange={(event) => setForm((current) => ({ ...current, githubHost: event.target.value as JobSpec['githubHost'] }))}
                >
                  <option value="github.com">github.com</option>
                  <option value="github.a8c.com">github.a8c.com</option>
                </select>
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
                <span className="job-meta">{job.branchName}</span>
              </button>
            ))}
            {jobs.length === 0 ? <p className="empty-state">No jobs yet.</p> : null}
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
                        <a href={artifactUrl(selectedJob.id, selectedJob.artifacts.summaryPath)} target="_blank" rel="noreferrer">summary</a>
                        <a href={artifactUrl(selectedJob.id, selectedJob.artifacts.gitDiffPath)} target="_blank" rel="noreferrer">git diff</a>
                        <a href={artifactUrl(selectedJob.id, selectedJob.artifacts.agentTranscriptPath)} target="_blank" rel="noreferrer">transcript</a>
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
                  <span>Live log stream</span>
                  <span>{selectedJob.id}</span>
                </div>
                <pre>{logContent || 'Waiting for output...'}</pre>
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

function artifactUrl(jobId: string, absolutePath: string): string {
  const filename = absolutePath.split('/').pop();
  return `/artifacts/${jobId}/${filename}`;
}
