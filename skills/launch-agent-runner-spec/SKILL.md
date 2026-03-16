---
name: launch-agent-runner-spec
description: Launch, hand off, or send a spec to agent-runner. Use this when the user wants to run a plan or spec in agent-runner — common phrasings include "hand off to agent-runner", "send to agent-runner", or "run this plan in agent-runner". Prefer an Agent OS spec directory with plan.md; allow a single plan file as fallback.
---

# Launch agent-runner from an existing spec

Use this skill only when the user already has a finished spec and wants to launch `agent-runner`.

Required inputs:
- repo
- spec
- runtime

Optional inputs:
- model
- effort
- branch

Rules:
- Prefer an Agent OS spec directory such as `agent-os/specs/<slug>/`.
- A spec directory must include `plan.md`. `shape.md`, `standards.md`, `references.md`, and `visuals/` are optional.
- Allow a single markdown plan file only as a fallback for non-Agent-OS workflows.
- When the spec references companion files, use the spec directory, not a single file.
- Single-file mode is only appropriate for self-contained plans.
- Do not draft, revise, or expand the spec. Launch only from the existing inputs.
- Prefer a local repo path when the current working directory is already the target repository.
- Follow logs by default. Use `--detach` only when the user explicitly asks for detached execution.

## Before launching — ask the user

If not already specified, ask the user which **capability profile** to use:

| Profile | Network | Push | Use when |
|---------|---------|------|----------|
| `safe` (default) | None | No | Code-only changes, no external deps needed |
| `repo-broker` | Git push/pull via broker | Yes | Agent needs to push a branch or create a PR |
| `docker-broker` | Git + Docker via broker | Yes | Agent needs to build/test in Docker |
| `dangerous` | Full ambient access | Yes | Agent needs arbitrary network (rare) |

The profile determines whether the agent can push its branch to the remote. With `safe`, you must extract changes manually from the workspace after completion. With `repo-broker` or higher, the agent can push and the branch will exist on the remote.

Pass the profile with `--profile <name>`. Repo access is auto-derived from the profile. For `dangerous`, also pass `--repo-access broker` or `--repo-access ambient`.

## Spec path rules

Absolute `--spec` paths **must** be inside `~/.agent-runner/specs/`. If the spec file is elsewhere (e.g. a Claude plan file in `~/.claude/plans/`), copy it first:

```bash
mkdir -p ~/.agent-runner/specs/<slug>
cp /path/to/plan.md ~/.agent-runner/specs/<slug>/plan.md
# For Agent OS spec dirs, copy the whole directory
```

Relative `--spec` paths are resolved relative to `--repo` root.

## Launch command

```bash
agent-runner run --repo <path-or-url> --spec <path> --runtime <claude|codex> [--model <model>] [--effort <auto|low|medium|high>] [--branch <name>] [--profile <safe|repo-broker|docker-broker|dangerous>] [--repo-access <none|broker|ambient>] [--host <github-host>] [--ref <ref>] [--detach]
```

If the target repo has branch naming conventions (in CLAUDE.md, CONTRIBUTING.md, etc.), the caller may check for them before launching and pass `--branch` with an appropriate name. If omitted, the agent will check the repo itself and auto-name the branch.

Behavior notes:
- If `--repo` is a local git checkout, `agent-runner` resolves `remote.origin.url`, uses the current branch by default, and still executes from a fresh clone.
- If `--repo` is a git URL, `--spec` may be repo-relative or an absolute path on the local machine.
- Agent OS spec directories are staged into `/spec`, preserving companion-file layout.
- Single-file specs are staged only as `/spec/plan.md`; sibling files are not copied automatically.
- The worker always starts from `/spec/plan.md` and can consult companion spec files selectively.

## After job completion

When the job completes, the output includes the **job ID** (a UUID). Use it to inspect results.

### Key artifacts

All artifacts live at `~/.agent-runner/artifacts/<job-id>/`:

| Artifact | Path | Use |
|----------|------|-----|
| Summary | `summary.json` | Status, changed files list, branch name, blocker reason |
| Diff | `git.diff` | Unified diff of all changes made |
| Final response | `outputs/final-response.json` | Agent's structured output |
| Transcript | `agent-transcript.log` | Full agent stdout/stderr |
| Progress | `outputs/progress.ndjson` | Timestamped progress events |

**Read the summary first** to understand what happened:
```bash
cat ~/.agent-runner/artifacts/<job-id>/summary.json | python3 -m json.tool
```

**Read the diff** to see exact code changes:
```bash
cat ~/.agent-runner/artifacts/<job-id>/git.diff
```

### CLI commands for inspection

```bash
agent-runner show <job-id>    # Job metadata + debug command
agent-runner logs <job-id>    # Execution log (progress markers)
agent-runner list             # All jobs with status summaries
```

### Workspace and changes

The agent's full working copy is preserved at:
```
~/.agent-runner/workspaces/<job-id>/repo/
```

This is a real git checkout with all changes committed (or staged). To apply changes to your local repo:

```bash
# Option 1: Apply the diff directly
cd /path/to/your/repo
git apply ~/.agent-runner/artifacts/<job-id>/git.diff

# Option 2: Cherry-pick from the workspace
cd ~/.agent-runner/workspaces/<job-id>/repo
git log --oneline -5  # find the commit(s)
cd /path/to/your/repo
git fetch ~/.agent-runner/workspaces/<job-id>/repo <branch>
git cherry-pick <sha>
```

### Profile and push behavior

- **`safe` profile** (default): No network access during execution. Changes exist only in the local workspace — nothing is pushed to the remote. You must extract changes manually (see above).
- **`repo-broker`/`docker-broker`**: The agent can push via the broker. Check `summary.json` → `branchName` for the remote branch.

Branch naming strategies (in priority order):
1. **Explicit**: Pass `--branch <name>` at launch — the branch is created with that name.
2. **Repo conventions**: When no explicit branch is given, the agent checks the repo for naming conventions (CLAUDE.md, CONTRIBUTING.md) and renames accordingly.
3. **Fallback**: `agent-runner/{brief-slug}` where the slug is a ≤20 char summary of the work.

The `summary.json` artifact includes a `branchSource` field (`explicit`, `convention`, or `auto`) indicating which strategy was used.
