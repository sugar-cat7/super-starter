# Working in this repository

Start with [README.md](README.md). The workspace manifests, `pnpm-workspace.yaml`, the lockfiles and each runtime's configuration are the sources of truth. All applications and libraries live in `packages/*`; application implementations may not import one another. Portable schemas/UI receive runtime adapters.

1. Preserve existing changes. Inspect Git status, the requested scope, and the current base before editing. Choose a [task skill](.agents/skills/application/SKILL.md); the other task entries are linked there.
2. For a new clone, select a name/scope/preset with `mise run setup`. For an initialized project, run `pnpm env:setup` and `pnpm env:doctor`. Diagnose failures using [troubleshooting](docs/troubleshooting.md). Do not invent global tool installations.
3. Find the owning package in its manifest. Start it with `pnpm dev -- <directory>`; modify its source or the canonical generator blueprints as appropriate. Add an application with `pnpm app:new`.
4. Run targeted package tests while editing, then `pnpm gate:pre-pr -- --base <base-sha>`. Use `pnpm gate:full` for final selected-configuration validation. [Quality rules](docs/quality.md) describe native requirements and the evidence report. Tests must collect cases; failures/timeouts are failures. Repair defects rather than removing assertions, skipping tests or relaxing baselines.
5. Commit through repository-local hooks. Pre-commit validates the index without fixing/restaging/stashing; pre-push checks the actual pushed commits. CI independently checks the committed content.
6. Build using `pnpm build`. Read [deployment](docs/cloudflare.md), then run `pnpm deploy:preflight -- --target <package-directory> --environment dev`. This does not deploy. Remote operations require the user's explicit authorization, approved dev resources and credentials. No production or public distribution is implied by a skill.

Before adopting/updating APIs, consult current official docs, release notes and installed SDK types; record versions, dates, URLs and a minimal compatibility result. Report what actually ran, its input SHA/content ID and limitations. If explicitly asked to merge, recheck current HEAD/base, required CI, unresolved reviews and conflicts; merge only the verified HEAD through the permitted method, then verify main and its CI. Do not self-approve or bypass protection.
