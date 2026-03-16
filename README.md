# agent-runner

Local autonomous worker for Claude Code and Codex. Clones a repo, launches an ephemeral Linux container, runs an AI agent against a spec, and collects artifacts.

## Quick start

```bash
pnpm install
agent-runner init          # prompts for API keys, writes .env
pnpm dev                   # starts web UI + broker on localhost
```

Then submit a job from the web UI, or from the CLI:

```bash
agent-runner run \
  --repo /path/to/repo \
  --spec agent-os/specs/feature-x \
  --runtime claude \
  --profile repo-broker --repo-access broker
```

## How it works

1. Accepts a job via the web UI or CLI.
2. Fresh-clones the repo into `~/.agent-runner/workspaces/<job-id>/repo`.
3. Stages the spec bundle into the container at `/spec`.
4. Starts an ephemeral Linux worker container with the selected agent.
5. Streams logs and progress events to the web UI in real time.
6. On exit, collects artifacts (logs, diffs, transcript, summary) under `~/.agent-runner/artifacts/<job-id>`.
7. The cloned workspace persists on the host after the container exits, including uncommitted changes.

## Access profiles

Each job runs under one of four profiles that control what the worker can reach on the host:

| Profile | Repo access | Docker access | Agent state |
|---------|-------------|---------------|-------------|
| `safe` | none | none | mounted (default) |
| `repo-broker` | brokered reads + writes | none | mounted (default) |
| `docker-broker` | brokered reads + writes | brokered (inc. `wp-env`) | mounted (default) |
| `dangerous` | ambient credentials | raw host socket | mounted (default) |

**Brokered access** means the worker gets a per-job lease token and uses `ar-*` wrapper commands. Brokered writes are limited to `origin` on non-default branches. Brokered reads may inspect other repos.

**Agent state** (`--agent-state`) is a separate toggle:
- `mounted` (default) — mounts `~/.claude`, `~/.claude.json`, `~/.codex` into the worker. Preserves config/auth/usage, but the worker can also modify them. Changes are audited after each run.
- `none` — no agent state mounts.

### Safety notes

- Containerization alone is not the trust boundary; the effective boundary depends on the selected profile.
- Do not use with untrusted repos, specs, or third-party instructions unless you are comfortable with the selected profile's access.
- The broker starts alongside the long-running server. Brokered CLI runs self-host a temporary broker if one is not already running.

## Spec input

Jobs launch from `--spec`, which points to an Agent OS spec directory or a single markdown file.

**Preferred: spec directory**

```
agent-os/specs/<slug>/
  plan.md          # required
  shape.md         # optional
  standards.md     # optional
  references.md    # optional
  visuals/         # optional
```

The full directory is copied into the container at `/spec`. The agent always starts from `/spec/plan.md`.

**Fallback: single file** — staged as `/spec/plan.md`. Only safe for self-contained plans; sibling files are not copied.

**Path rules:**
- Repo-relative spec paths are always allowed.
- Absolute paths must be under `AGENT_RUNNER_SPEC_ROOT` (default: `~/.agent-runner/specs`).
- Symlinks that resolve outside the allowed root are rejected.

## Authentication

| Runtime | Required env var |
|---------|-----------------|
| Claude | `ANTHROPIC_API_KEY` |
| Codex | `OPENAI_API_KEY` |

If the key is missing, the job fails before Docker starts.

**Resolution order:** process environment, then repo-root `.env` (only for unset keys).

```bash
agent-runner init                    # interactive setup, writes .env
# or manually:
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

Mounted agent state (`~/.claude`, `~/.codex`) provides config and usage state but is not used as an automatic secret source for these keys.

## CLI

```bash
agent-runner init
agent-runner run [options]
agent-runner list
agent-runner show <job-id>
agent-runner logs <job-id> [--follow] [--debug]
agent-runner cancel <job-id>
agent-runner skills install [--force] [--claude-only] [--codex-only]
```

**`run` options:**

| Flag | Description |
|------|-------------|
| `--repo <path-or-url>` | Local path or git URL (required) |
| `--spec <path>` | Spec directory or file (required) |
| `--runtime <claude\|codex>` | Agent runtime (required) |
| `--model <model>` | Passed to the runtime; omit for default |
| `--effort <auto\|low\|medium\|high>` | Default: `auto` |
| `--host <hostname>` | GitHub host (default: `github.com`) |
| `--ref <ref>` | Git ref to check out |
| `--branch <name>` | Working branch name; auto-generated if omitted |
| `--profile <name>` | Access profile (see above) |
| `--repo-access <none\|broker\|ambient>` | Must match profile |
| `--agent-state <mounted\|none>` | Default: `mounted` |
| `--detach` | Run in background |

**Normalization:**
- Local `--repo` paths resolve `remote.origin.url`, default `--ref` to current branch, and convert in-repo spec paths to repo-relative form. Execution still happens from a fresh clone.
- When `--branch` is omitted, the agent checks the repo for naming conventions (CLAUDE.md, CONTRIBUTING.md) and renames accordingly.

## Web UI

The web form accepts the same inputs as the CLI. Job detail shows the spec, branch, SHA, workspace, profile, logs (run + debug), agent progress, agent-state audit, and security audit.

The server listens on `localhost:4317` by default, falling back to another open port if `4317` is in use.

## Worker environment

The worker image ships with: Node.js 22, npm, pnpm (Corepack), Python 3, PHP, Composer, git, Docker CLI, openssh-client, ripgrep.

**Container layout:**
- `/workspace` — repo checkout
- `/spec` — staged spec bundle (read-only)
- `/inputs/prompt.txt` — generated prompt
- `/inputs/result-schema.json` — output schema
- `/outputs/final-response.json` — agent's structured response

**Auth failure detection:** if the agent emits an auth failure in the logs, agent-runner stops the container and fails the job immediately.

## Configuration

All optional. Set in the environment or in a repo-root `.env`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_RUNNER_HOME` | `~/.agent-runner` | Root directory for jobs, workspaces, artifacts |
| `AGENT_RUNNER_SPEC_ROOT` | `~/.agent-runner/specs` | Allowed root for absolute spec paths |
| `AGENT_RUNNER_GH_CONFIG` | `~/.config/gh` | GitHub CLI config to mount |
| `AGENT_RUNNER_CLAUDE_DIR` | `~/.claude` | Claude state directory |
| `AGENT_RUNNER_CLAUDE_SETTINGS` | `~/.claude.json` | Claude settings file |
| `AGENT_RUNNER_CODEX_DIR` | `~/.codex` | Codex state directory |
| `AGENT_RUNNER_GITHUB_PROXY_URL` | _(none)_ | HTTPS proxy for non-`github.com` hosts (e.g. `socks5://host.docker.internal:8080`). Must use `socks5://`, `socks4://`, `http://`, or `https://` scheme. |
| `AGENT_RUNNER_DOCKER_SOCKET` | auto-detected | Docker socket path |
| `AGENT_RUNNER_IMAGE` | `agent-runner-worker:latest` | Worker image tag |
| `AGENT_RUNNER_BROKER_PORT` | `4318` | Broker listen port |
| `AGENT_RUNNER_BROKER_HOST` | `host.docker.internal` | Broker hostname visible from containers |

## Skills

The canonical launch skill lives at `skills/launch-agent-runner-spec`. Install it with:

```bash
agent-runner skills install
```

Installs to `~/.claude/skills/` and `~/.codex/skills/`. The skill launches from an existing spec only; it does not draft or revise plans.

## Development

```bash
pnpm install
pnpm dev          # web UI + hot reload
pnpm build        # production build
pnpm start        # production server
```

**Verification:**

```bash
pnpm typecheck
pnpm test
pnpm smoke:docker
pnpm smoke:wp-env
```

**CLI during development:**

```bash
pnpm cli -- run --repo ... --spec ... --runtime claude
pnpm link:global      # makes `agent-runner` available on PATH
pnpm unlink:global    # remove global link
```

The global link runs `dist/server/server/cli.js` — rebuild after local changes.
