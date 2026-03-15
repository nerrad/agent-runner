# agent-runner

Local autonomous worker for Claude Code and Codex.

## Safety

This tool is designed for trusted local use only.

- Containerization is not the trust boundary by itself. The effective trust boundary depends on the selected access profile.
- `safe` avoids raw repo credentials and the raw host Docker socket, but still mounts agent state by default unless you opt out with `--agent-state none`.
- `repo-broker` and `docker-broker` route repo and Docker actions through host-side brokers with per-job lease tokens.
- `dangerous` preserves broad host passthrough for compatibility: ambient repo credentials, raw host Docker access, and mounted agent state.
- Do not use this tool with untrusted repositories, untrusted specs, or arbitrary third-party instructions unless you are comfortable with the selected profile's effective access.

## What it does

- Serves the web UI on `127.0.0.1`
- Exposes a broker endpoint that must remain reachable from worker containers
- Accepts jobs through either the web UI or the `agent-runner` CLI
- Fresh-clones a repo into `~/.agent-runner/workspaces/<job-id>/repo`
- Starts an ephemeral Linux worker container for each job
- Preserves the cloned repo on the host after the container exits, including uncommitted changes
- Stages shared job inputs under `~/.agent-runner/artifacts/<job-id>/inputs` and worker-written outputs under `~/.agent-runner/artifacts/<job-id>/outputs`
- Captures logs, summaries, diffs, the staged spec bundle, and the agent transcript under `~/.agent-runner/artifacts/<job-id>`
- Audits mounted agent-state changes at job end and writes `agent-state-summary.json` plus `agent-state.diff`
- Writes a host-authored `security-audit.jsonl` artifact when broker or profile enforcement blocks an action
- Starts the broker alongside the long-running server, and brokered CLI jobs will temporarily self-host the broker if one is not already running

## Profiles

- `safe`: no raw repo credentials, no raw host Docker socket, mounted agent state by default
- `repo-broker`: `safe` plus brokered repo reads and explicit repo write operations
- `docker-broker`: `repo-broker` plus brokered Docker workflows, including explicit `wp-env` support without requiring `dangerous`
- `dangerous`: raw host Docker socket, ambient repo credentials, and mounted agent state for compatibility

Mounted agent state is a separate control:

- Default: `--agent-state mounted`
- Hardened option: `--agent-state none`
- Mounted agent state includes `~/.claude`, `~/.claude.json`, and `~/.codex`
- Those mounts preserve local config, instructions, auth, usage, and cost/statistics behavior, but the worker may also read and modify them
- Changes under those mounts are audited after each run, but that audit is forensic rather than preventive

## Baseline toolchain in the worker

The worker image ships with these tools available out of the box:

- Node.js 22
- `npm`
- `pnpm` via Corepack
- `python` and `python3`
- `php`
- `composer`
- `git`
- `docker` CLI
- `openssh-client`
- `ripgrep`

## Spec input

`agent-runner` launches from `--spec`, not just a single plan file.

Preferred input is an Agent OS spec directory:

```text
agent-os/specs/<slug>/
  plan.md
  shape.md
  standards.md
  references.md
  visuals/
```

Rules:

- `plan.md` is required in bundle mode
- `shape.md`, `standards.md`, `references.md`, and `visuals/` are optional
- A single markdown file still works as a plan-only fallback
- The worker always sees the staged bundle at `/spec`
- `/spec/plan.md` is always the agent entrypoint

Relative-path behavior:

- If you pass an Agent OS spec directory, agent-runner copies that directory into `/spec`, so companion-file references inside the bundle keep working
- If you pass a single file, agent-runner stages only that file as `/spec/plan.md`
- Single-file mode is only safe for self-contained plans; relative references to sibling files next to that file are not copied automatically
- Absolute host paths written inside the spec are not rewritten for the container

External spec root:

- Repo-relative spec paths are always allowed
- Absolute spec paths are allowed only under `AGENT_RUNNER_SPEC_ROOT`
- Default external spec root: `~/.agent-runner/specs`
- Paths outside that root are rejected
- Spec staging rejects symlinks that resolve outside the allowed source root

## How agents start in the container

Each job stages runtime inputs under `/inputs`, worker outputs under `/outputs`, and starts the selected agent from `/workspace` inside the worker container.

Shared container setup:

- worker runs as a non-root user context using the host UID/GID when available
- repo checkout mounted at `/workspace`
- staged spec bundle mounted read-only at `/spec`
- prompt written to `/inputs/prompt.txt`
- result schema written to `/inputs/result-schema.json`
- final JSON response written to `/outputs/final-response.json`
- mounted agent state, when enabled, is outside the immutable input model and audited separately

Codex launch:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /workspace --output-schema /inputs/result-schema.json -o /outputs/final-response.json "$PROMPT"
```

Claude launch:

```bash
claude -p --dangerously-skip-permissions --output-format json --json-schema "$SCHEMA" "$PROMPT" > /outputs/final-response.json
```

Prompt contract:

- start from `/spec/plan.md`
- consult `/spec/shape.md`, `/spec/standards.md`, `/spec/references.md`, and `/spec/visuals` only when relevant
- work until complete or hard blocked
- emit terse single-line best-effort progress updates prefixed with `[progress]` before major task switches, long-running commands, and likely silent stretches
- when no explicit `--branch` was given, the prompt includes branch naming instructions: check the repo for conventions and rename the working branch before pushing (using `ar-branch-rename` in broker mode or `git branch -m` in dangerous mode)
- return JSON only, matching the staged schema

Live log behavior:

- agent-runner writes runner-authored lifecycle markers prefixed with `[agent-runner]` when cloning begins, bootstrapping begins, the worker/agent launch begins, the container starts, and the job reaches a terminal state
- while a job is `running`, agent-runner also emits `[agent-runner] still running; waiting for agent output` after a silent interval with no agent stdout/stderr
- best-effort agent progress lines prefixed with `[progress]` are log-only and do not change the final JSON result contract

## Authentication

Unattended Docker runs require real API keys in the environment.

- Claude jobs require `ANTHROPIC_API_KEY`
- Codex jobs require `OPENAI_API_KEY`
- If the selected runtime key is missing, the job fails before Docker starts
- Host `~/.claude`, `~/.claude.json`, and `~/.codex` are mounted by default for config, instructions, auth, and usage state, but they are not used as an automatic secret source for `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`

Repo and Docker access:

- `repo-broker` does not mount raw SSH agent or raw `gh` config into the worker
- `docker-broker` does not mount the raw host Docker socket into the worker
- Brokered jobs get a per-job lease token and must use the provided `ar-*` wrapper commands for host-mediated repo and Docker actions
- Brokered reads may inspect other repos through `git` or `gh`
- Brokered writes are limited to `origin` and cannot target the repo's default branch
- `dangerous` is the profile that preserves raw ambient repo credentials and raw host Docker passthrough
- The long-running web/dev server owns the broker lifecycle in normal operation; direct brokered CLI runs fall back to a per-job broker that is started before the worker launches and closed when the runner exits

Environment resolution order:

- existing process environment
- repo-root `.env` file, only for keys that are not already set in the process environment

Quick setup:

```bash
agent-runner init
```

That command prompts for `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` and writes them to a local `.env` file in the repo root.

Manual setup:

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

Or create a repo-root `.env` file:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

Optional overrides:

```bash
export AGENT_RUNNER_HOME="$HOME/.agent-runner"
export AGENT_RUNNER_GH_CONFIG="$HOME/.config/gh"
export AGENT_RUNNER_CLAUDE_DIR="$HOME/.claude"
export AGENT_RUNNER_CLAUDE_SETTINGS="$HOME/.claude.json"
export AGENT_RUNNER_CODEX_DIR="$HOME/.codex"
export AGENT_RUNNER_SPEC_ROOT="$HOME/.agent-runner/specs"
export AGENT_RUNNER_GITHUB_PROXY_URL="socks5://host.docker.internal:8080"
export AGENT_RUNNER_DOCKER_SOCKET="$HOME/.orbstack/run/docker.sock"
export AGENT_RUNNER_IMAGE="agent-runner-worker:latest"
export AGENT_RUNNER_BROKER_PORT="4318"
```

## Development

```bash
pnpm install
pnpm dev
```

Open the localhost URL printed at startup. `4317` is still the preferred default, but agent-runner now falls back to another open localhost port if `4317` is already in use.

## CLI

Use the CLI directly from the repo during development:

```bash
pnpm cli --help
```

Or link the package globally so `agent-runner` is available on your shell `PATH`:

```bash
pnpm link:global
```

Remove the global link with:

```bash
pnpm unlink:global
```

The global command still runs this repo's built CLI entrypoint at `dist/server/server/cli.js`, so rebuild after local code changes before relying on the linked command.

Run from a local repo checkout:

```bash
agent-runner run --repo /path/to/repo --spec agent-os/specs/feature-x --runtime claude --model sonnet --effort high --profile safe --agent-state mounted
```

Run from a git URL:

```bash
agent-runner run --repo git@github.com:owner/repo.git --spec agent-os/specs/feature-x --runtime codex --model o3 --effort medium --profile repo-broker --repo-access broker
```

Available commands:

```bash
agent-runner init
agent-runner run --repo <path-or-url> --spec <path> --runtime <claude|codex> [--model <model>] [--effort <auto|low|medium|high>] [--host <github-host>] [--ref <ref>] [--branch <name>] [--profile <safe|repo-broker|docker-broker|dangerous>] [--repo-access <none|broker|ambient>] [--agent-state <mounted|none>] [--detach]
agent-runner list
agent-runner show <job-id>
agent-runner logs <job-id> [--follow] [--debug]
agent-runner cancel <job-id>
agent-runner skills install [--force] [--claude-only] [--codex-only]
```

Normalization rules:

- If `--repo` is a local path, agent-runner resolves `remote.origin.url`, defaults `--ref` to the current branch, and converts in-repo spec paths to repo-relative form
- If `--repo` is a git URL, `--spec` may be repo-relative or an absolute path under `AGENT_RUNNER_SPEC_ROOT`
- Local repo path support is only for launch convenience; execution still happens from a fresh clone
- `--model` is optional and passed through to the selected runtime; if omitted, the runtime falls back to its mounted local config/default model
- `--branch` is optional; if provided, the working branch is created with that exact name (`branchSource: explicit` in the summary artifact)
- If `--branch` is omitted, the agent checks the repo for branch naming conventions (CLAUDE.md, CONTRIBUTING.md) and renames accordingly (`branchSource: convention`); if no conventions are found, the branch defaults to `agent-runner/{brief-slug}` (`branchSource: auto`)
- `--effort` defaults to `auto`; Claude uses its native `--effort` flag and Codex uses a config override in `exec` mode
- `--agent-state mounted` is the default because it preserves local config/auth/statistics behavior
- `--agent-state none` disables the `~/.claude`, `~/.claude.json`, and `~/.codex` mounts
- `repo-broker` and `docker-broker` require `--repo-access broker`
- `safe` requires `--repo-access none`
- `dangerous` does not allow `--repo-access none`
- `dangerous` is the compatibility profile that preserves raw host Docker and ambient repo credential passthrough
- Use `docker-broker` when you need `wp-env` but do not want raw host Docker exposed inside the worker

## Web UI

The web form accepts the same job inputs:

- repo URL
- ref
- branch (optional — auto-generated if empty)
- spec path
- runtime
- optional model
- effort / thinking level
- GitHub host or GitHub Enterprise hostname
- access profile
- repo access mode
- agent state mode

Job detail shows:

- original spec path
- requested model and effort
- resolved spec mode (`bundle` or `file`)
- detected staged spec files
- branch, SHA, workspace, profile, repo access mode, agent state mode, debug attach command, and separate run/debug logs with runner lifecycle markers plus best-effort agent progress lines
- agent-state audit artifacts when mounted agent state changed
- a security audit artifact when brokered or profile-gated actions are blocked

Logging notes:

- Claude jobs always write a dedicated `debug.log` artifact via the native Claude `--debug-file` flag
- The web UI can toggle between the run log and debug log for each job
- `agent-runner logs <job-id> --debug --follow` tails the debug log from the terminal
- If Claude or Codex emits an auth failure in the observed logs, agent-runner stops the container and fails the job immediately instead of waiting on a hung session
- The cloned workspace remains on the host after the container exits, including uncommitted changes
- Worker-generated files written under `/outputs` remain on the host after the container exits
- Blocked broker and policy actions are recorded in `security-audit.jsonl` and exposed in the web UI

## Skills

The canonical launch skill lives in this repo at `skills/launch-agent-runner-spec`.

Install it into the user skill roots with:

```bash
agent-runner skills install
```

Install targets:

- Claude: `~/.claude/skills/launch-agent-runner-spec`
- Codex: `~/.codex/skills/launch-agent-runner-spec`

The skill launches from an existing spec only. It does not draft or revise plans.

## Production build

```bash
pnpm build
pnpm start
```

## Verification

```bash
pnpm typecheck
pnpm test
pnpm smoke:docker
pnpm smoke:wp-env
```

Manual auth validation:

```bash
# Claude should fail before container start when no env key is available
env -u ANTHROPIC_API_KEY \
  pnpm cli -- run --repo <path-or-url> --spec <path> --runtime claude

# Claude should run when an API key is set directly
ANTHROPIC_API_KEY=... pnpm cli -- run --repo <path-or-url> --spec <path> --runtime claude

# Claude should also run when .env contains ANTHROPIC_API_KEY
pnpm cli -- run --repo <path-or-url> --spec <path> --runtime claude

# Codex should fail before container start when no env key is available
env -u OPENAI_API_KEY \
  pnpm cli -- run --repo <path-or-url> --spec <path> --runtime codex

# Codex should run when OPENAI_API_KEY is set directly
OPENAI_API_KEY=... pnpm cli -- run --repo <path-or-url> --spec <path> --runtime codex

# Codex should also run when .env contains OPENAI_API_KEY
pnpm cli -- run --repo <path-or-url> --spec <path> --runtime codex
```

## Notes

- `gh` commands inside the worker depend on valid host auth in `~/.config/gh`
- Claude Code usage and config state flow through the mounted host `~/.claude` and `~/.claude.json`, but unattended container auth now requires `ANTHROPIC_API_KEY` from the process environment or repo-root `.env`
- Codex usage and config state flow through the mounted host `~/.codex`, but unattended container auth now requires `OPENAI_API_KEY` from the process environment or repo-root `.env`
- Non-`github.com` hosts can inherit a proxy URL from `AGENT_RUNNER_GITHUB_PROXY_URL`
- Detached jobs run in a background helper process; one active job is enforced through an app-level lock file
