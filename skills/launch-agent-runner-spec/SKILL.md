---
name: launch-agent-runner-spec
description: Launch agent-runner from an existing Claude or Agent OS spec. Use this when the user already has a plan/spec bundle and wants to run it in agent-runner with Claude Code or Codex. Prefer an Agent OS spec directory with plan.md; allow a single plan file as fallback.
---

# Launch agent-runner from an existing spec

Use this skill only when the user already has a finished spec and wants to launch `agent-runner`.

Required inputs:
- repo
- spec
- runtime

Rules:
- Prefer an Agent OS spec directory such as `agent-os/specs/<slug>/`.
- A spec directory must include `plan.md`. `shape.md`, `standards.md`, `references.md`, and `visuals/` are optional.
- Allow a single markdown plan file only as a fallback for non-Agent-OS workflows.
- Do not draft, revise, or expand the spec. Launch only from the existing inputs.
- Prefer a local repo path when the current working directory is already the target repository.
- Follow logs by default. Use `--detach` only when the user explicitly asks for detached execution.

Command pattern:

```bash
agent-runner run --repo <path-or-url> --spec <path> --runtime <claude|codex> [--host <github-host>] [--ref <ref>] [--detach]
```

Behavior notes:
- If `--repo` is a local git checkout, `agent-runner` resolves `remote.origin.url`, uses the current branch by default, and still executes from a fresh clone.
- If `--repo` is a git URL, `--spec` must be repo-relative.
- The worker always starts from `/spec/plan.md` and can consult companion spec files selectively.
