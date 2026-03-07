# agent-runner

Local autonomous worker for Claude Code and Codex.

## What it does

- Runs on `127.0.0.1` only
- Accepts one active job at a time through a React web UI
- Fresh-clones a repo into `~/.agent-runner/workspaces/<job-id>/repo`
- Starts an ephemeral Linux worker container for each job
- Mounts the host Docker socket so `@wordpress/env` can start nested WordPress environments
- Mounts host `~/.config/gh` for `gh` CLI usage inside the worker
- Forwards the host SSH agent into the worker for git-over-SSH
- Captures logs, summaries, diffs, and the agent transcript under `~/.agent-runner/artifacts/<job-id>`

## Required environment

Set whichever key matches the runtime you plan to use:

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

Optional overrides:

```bash
export AGENT_RUNNER_HOME="$HOME/.agent-runner"
export AGENT_RUNNER_GH_CONFIG="$HOME/.config/gh"
export AGENT_RUNNER_A8C_PROXY_URL="socks5://host.docker.internal:8080"
export AGENT_RUNNER_DOCKER_SOCKET="$HOME/.orbstack/run/docker.sock"
export AGENT_RUNNER_IMAGE="agent-runner-worker:latest"
```

## Development

```bash
pnpm install
pnpm dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

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

- `gh` commands inside the worker depend on valid host auth in `~/.config/gh`.
- `github.a8c.com` jobs inherit the SOCKS proxy URL from `AGENT_RUNNER_A8C_PROXY_URL`.
- Cancel works by stopping the running container and preserving the canceled state in the job record.
