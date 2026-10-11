# Troubleshooting

Start with `pnpm env:doctor`. It is read-only: no install, cloud mutation or secret values. It checks selected tool versions, prepared types, native OS prerequisites and Git hook configuration. Fix the named prerequisite and rerun `pnpm env:setup`.

Noninteractive init requires a name and scope. Unknown presets/features/flags/environments fail early. Collision errors identify the protected file; use dry-run and a reviewed migration rather than deleting user work. An interrupted transaction uses `pnpm template:init -- --recover` with the original initialization flags. Installation failure leaves a coherent generated project; retry setup after correcting the dependency/network problem.

Dev servers use strict ports and root startup allocates worktree-local ports, persistence and registry. A ready timeout or exited upstream fails startup; logs carry package names. Ctrl-C stops only processes owned by the launcher. Direct package scripts use their configured default port; use root startup to avoid simultaneous-worktree conflicts.

Worker preparation builds SDK output/types, applies migrations and seeds only a newly prepared local database. Repeated setup does not reseed deleted notes. Local state belongs to `.state/<package-directory>`; migration and dev share it. Back up user data before intentionally removing it. A missing remote resource ID never falls back to local or production.

For an SDK transport failure, run the owning Worker's runtime test with `STARTER_RUNTIME_TRANSPORT_DIAGNOSTICS=true`. The SDK child reports only bounded error identifiers and whether a socket error exists; URLs, messages, headers, bodies and socket addresses are omitted. Windows Worker CI enables this diagnostic. Preserve the failed response and assertions while investigating the actual error code.

No-tests/timeout/cancel fails the command. Read `artifacts/gate-*.json` and rerun the named package command. A snapshot difference requires investigation and intentional design review. Native library/display failures require the actual target OS environment. Do not replace native tests with browser mocks.
