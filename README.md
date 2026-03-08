# agent-runner

Local autonomous worker for Claude Code and Codex.

## Safety

This tool is designed for trusted local use only.

- It mounts your local Docker socket, SSH agent, GitHub CLI auth, and agent auth state into the worker container
- It runs the selected agent with high trust inside that container
- Do not use it with untrusted repositories, untrusted specs, or arbitrary third-party instructions unless you are comfortable granting that level of access

## What it does

- Runs on `127.0.0.1` only
- Accepts jobs through either the web UI or the `agent-runner` CLI
- Fresh-clones a repo into `~/.agent-runner/workspaces/<job-id>/repo`
- Starts an ephemeral Linux worker container for each job
- Mounts the host Docker socket so `@wordpress/env` can start nested WordPress environments
- Mounts host `~/.config/gh` for `gh` CLI usage inside the worker
- Mounts host `~/.claude`, `~/.claude.json`, and `~/.codex` into the worker home so Claude Code and Codex use the same local login state and write usage back to the normal host tracking files
- Forwards the host SSH agent into the worker for git-over-SSH
- Captures logs, summaries, diffs, the staged spec bundle, and the agent transcript under `~/.agent-runner/artifacts/<job-id>`

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

## How agents start in the container

Each job stages runtime artifacts under `/artifacts` and starts the selected agent from `/workspace` inside the worker container.

Shared container setup:

- repo checkout mounted at `/workspace`
- staged spec bundle mounted read-only at `/spec`
- prompt written to `/artifacts/prompt.txt`
- result schema written to `/artifacts/result-schema.json`
- final JSON response written to `/artifacts/final-response.json`

Codex launch:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /workspace --output-schema /artifacts/result-schema.json -o /artifacts/final-response.json "$PROMPT"
```

Claude launch:

```bash
claude -p --dangerously-skip-permissions --output-format json --json-schema "$SCHEMA" "$PROMPT" > /artifacts/final-response.json
```

Prompt contract:

- start from `/spec/plan.md`
- consult `/spec/shape.md`, `/spec/standards.md`, `/spec/references.md`, and `/spec/visuals` only when relevant
- work until complete or hard blocked
- return JSON only, matching the staged schema

## Authentication

Local login state is the primary auth path for Claude Code and Codex.

- Claude jobs use the mounted host `~/.claude` and `~/.claude.json`
- Codex jobs use the mounted host `~/.codex`
- If present, `ANTHROPIC_API_KEY` is passed through only for Claude jobs
- If present, `OPENAI_API_KEY` is passed through only for Codex jobs

API keys are optional fallback auth, not required when local login state is already valid:

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

Optional overrides:

```bash
export AGENT_RUNNER_HOME="$HOME/.agent-runner"
export AGENT_RUNNER_GH_CONFIG="$HOME/.config/gh"
export AGENT_RUNNER_CLAUDE_DIR="$HOME/.claude"
export AGENT_RUNNER_CLAUDE_SETTINGS="$HOME/.claude.json"
export AGENT_RUNNER_CODEX_DIR="$HOME/.codex"
export AGENT_RUNNER_GITHUB_PROXY_URL="socks5://host.docker.internal:8080"
export AGENT_RUNNER_DOCKER_SOCKET="$HOME/.orbstack/run/docker.sock"
export AGENT_RUNNER_IMAGE="agent-runner-worker:latest"
```

## Development

```bash
pnpm install
pnpm dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

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
agent-runner run --repo /path/to/repo --spec agent-os/specs/feature-x --runtime claude --model sonnet --effort high
```

Run from a git URL:

```bash
agent-runner run --repo git@github.com:owner/repo.git --spec agent-os/specs/feature-x --runtime codex --model o3 --effort medium
```

Available commands:

```bash
agent-runner run --repo <path-or-url> --spec <path> --runtime <claude|codex> [--model <model>] [--effort <auto|low|medium|high>] [--host <github-host>] [--ref <ref>] [--detach]
agent-runner list
agent-runner show <job-id>
agent-runner logs <job-id> [--follow]
agent-runner cancel <job-id>
agent-runner skills install [--force] [--claude-only] [--codex-only]
```

Normalization rules:

- If `--repo` is a local path, agent-runner resolves `remote.origin.url`, defaults `--ref` to the current branch, and converts in-repo spec paths to repo-relative form
- If `--repo` is a git URL, `--spec` must be repo-relative
- Local repo path support is only for launch convenience; execution still happens from a fresh clone
- `--model` is optional and passed through to the selected runtime; if omitted, the runtime falls back to its mounted local config/default model
- `--effort` defaults to `auto`; Claude uses its native `--effort` flag and Codex uses a config override in `exec` mode

## Web UI

The web form accepts the same job inputs:

- repo URL
- ref
- spec path
- runtime
- optional model
- effort / thinking level
- GitHub host or GitHub Enterprise hostname

Job detail shows:

- original spec path
- requested model and effort
- resolved spec mode (`bundle` or `file`)
- detected staged spec files
- branch, SHA, workspace, debug attach command, and live logs

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

## Notes

- `gh` commands inside the worker depend on valid host auth in `~/.config/gh`
- Claude Code usage and auth state flow through the mounted host `~/.claude` and `~/.claude.json`
- Codex usage and auth state flow through the mounted host `~/.codex`
- Non-`github.com` hosts can inherit a proxy URL from `AGENT_RUNNER_GITHUB_PROXY_URL`
- Detached jobs run in a background helper process; one active job is enforced through an app-level lock file
