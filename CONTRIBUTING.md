# Contributing to `pjhb-legalcontext-ce`

This is the PJHB fork of [`protomated/legal-context-ce`](https://github.com/protomated/legal-context-ce). The fork's purpose is to land PJHB-specific extensions (Bardal-factor extraction, Clio Stages embedding, settlement calculator, Grow ↔ Manage field-mapping, write-tool surface for Clio Manage) plus security fixes that PJHB needs ahead of any upstream timeline.

This file documents **how the fork is maintained**. It is **PJHB-internal**; it is not intended for upstream PR.

For upstream contributions, follow [`protomated/legal-context-ce`'s own contribution model](https://github.com/protomated/legal-context-ce) — not this file.

## Fork-upkeep posture: rebase

PJHB's modifications are kept as a clean linear series of commits on top of upstream `main`. When upstream advances, the PJHB series is rebased onto the new upstream HEAD.

- **Rationale:** linear history is load-bearing for security review. Each PJHB modification is one commit; a reviewer can walk `git log` and see one fix per commit.
- **Trade-off:** SHAs change on rebase. PJHB workspace cross-references record commits by topic + date + commit message rather than SHA so they survive rebase.

## Force-push policy

Force-push to `main` is permitted **only** during a rebase-onto-upstream event. Specifically:

- ✅ `git push origin main --force-with-lease` after a successful `git rebase upstream/main`.
- ✅ `git push origin <feature-branch> --force-with-lease` for in-flight rebase of a feature branch.
- ❌ Force-push during routine commit work (no rebase happened).
- ❌ Force-push without `--force-with-lease` (always use the lease guard).
- ❌ Force-push to upstream remote (PJHB does not push to upstream; upstream PRs are filed via `gh pr create`).

If a force-push is contemplated for any reason other than rebase, the operator approves first.

## Upstream-sync cadence

- **Monthly check** by default. On the 1st of each month, run `git fetch upstream && git log upstream/main..HEAD` to see if upstream has advanced.
- **On-event sync** when upstream advancement is signaled by:
  - A noteworthy upstream PR merging (visible via `gh pr list -R protomated/legal-context-ce --state merged`).
  - A security advisory affecting upstream's deps.
  - PJHB filing a PR to upstream (the PR's mergeability gives signal).
- **Sync action:** rebase fork's PJHB series onto new upstream HEAD; resolve conflicts manually (no auto-resolution); force-push-with-lease to `origin/main`.

## Commit-message conventions

```
<type>(<scope>): <one-line summary>

<longer description if needed>

Refs: PJHB Pass <N> <workstream>
```

Types: `fix(security)`, `fix(build)`, `chore(deps)`, `docs`, `refactor`, `feat`.

## Working on the fork

```bash
# One-time setup
git clone https://github.com/PESystems/pjhb-legalcontext-ce.git
cd pjhb-legalcontext-ce
git remote add upstream https://github.com/protomated/legal-context-ce.git
bun install --legacy-peer-deps

# Routine commit
git checkout main
# ... make changes ...
git add <files>
git commit -m "fix(security): ..."
git push origin main

# Upstream-sync (rebase event)
git fetch upstream
git rebase upstream/main
# ... resolve conflicts if any ...
git push origin main --force-with-lease
```

## Upstream PR filing

Upstream PRs are filed for **good-citizen contributions only** — security fixes and bug fixes that upstream benefits from. PJHB-distinctive features (Bardal extractor, Stages embedding, calculator, fieldMapping module) stay fork-local.

To file an upstream PR:

```bash
git checkout -b upstream/pr-<topic> upstream/main
git cherry-pick <sha-from-fork-main>
git push origin upstream/pr-<topic>
gh pr create -R protomated/legal-context-ce -B main -H PESystems:upstream/pr-<topic>
```

Use the prepared issue + PR drafts in PJHB workspace under `04_product_architecture/integrations/PJHB_upstream_issue_draft_*.md`.

## License

This fork inherits upstream's MPL-2.0 license. PJHB-new files (not modifying upstream MPL files) may carry any license, but for simplicity all PJHB-fork files are also MPL-2.0 unless explicitly noted.

## Reference

- PJHB workspace: `C:\Users\Malik\Documents\Claude\Projects\PJHB_WrkSps\` (operator-local, not public).
- Fork-upkeep decision: workspace path `00_admin/decision_logs/2026-04-26_pass6a_fork_upkeep_posture.md`.
