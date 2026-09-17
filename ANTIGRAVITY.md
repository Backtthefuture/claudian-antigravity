# Antigravity preview

This fork adds one optional provider to Claudian 2.2.7 (`8fc1f920bf98c39d1c1499509684dc2526ba65bc`). It uses the installed `agy` CLI and its existing authentication. It preserves Claudian's interface and existing providers rather than replacing them. It does not implement another agent loop or copy native Skills into Claudian.

## Setup

1. Install and sign in to the official Antigravity CLI. Verify `agy models` and `agy -p /skills --output-format json` in a terminal.
2. Install BRAT from Obsidian's community plugins. In BRAT, choose **Add a beta plugin**, enter `Backtthefuture/claudian-antigravity`, and select `2.2.7-antigravity.4` or a later verified release. Start with a separate desktop vault. The plugin ID remains `realclaudian`; this updates upstream Claudian in the same vault. Back up the original plugin directory and `.claudian/` before replacing an existing installation. Use this fork's BRAT entry for future updates; community-market updates or a BRAT entry tracking upstream can overwrite the patch.
3. Open **Claudian → Providers → Antigravity**, enable it, and set the absolute `agy` executable path if discovery cannot find it.
4. Discover models, then select the models to show in chat. Discovery never enables models automatically. Model aliases and ordering use Claudian's existing controls.
5. Start a new conversation and choose an Antigravity model. Type `/` to browse native Skills. Use **Escape** in the input to stop a running answer.

Proxy variables belong in Claudian's shared/provider environment settings only when the local network needs them. Start with the same environment that works in a terminal. A Google eligibility `EOF` can occur before the agent starts; the provider surfaces that error and supports a fresh retry. This patch does not refresh credentials or change network policy.

## Three maintenance areas

| Area | Files under `src/providers/antigravity/` | Contract |
| --- | --- | --- |
| Execution | `AntigravityExecutionBackend.ts`, `AntigravityProcess.ts`, `AntigravityHistory.ts` | Structured streaming, bounded process cleanup, cancellation, explicit conversation IDs, provider-owned display cache |
| Models | `AntigravityMetadata.ts`, `AntigravityChatUIConfig.ts`, `AntigravitySettingsTab.ts`, `settings.ts` | Native `agy models`, namespaced model IDs, explicit model selection |
| Skills | `AntigravityMetadata.ts`, `AntigravityWorkspace.ts`, `AntigravitySkillCache.ts` | Native `agy -p /skills --output-format json`, workspace-shared metadata cache, leading slash passed unchanged to agy |

The only upstream production entry files changed are `src/providers/index.ts` and `src/providers/defaultProviderConfigs.ts`. `ProviderModuleCatalog.test.ts` also includes the new optional provider. Shared chat UI and execution contracts are unchanged.

## Continuation and limits

- Each conversation saves its own native ID and resumes using `--conversation ID`. The adapter never uses global `--continue` or guesses the latest CLI session.
- Text history is stored as a provider-owned display snapshot in Claudian metadata. Native context remains in agy's own session. The patch does not read, modify, or delete private agy databases. Detailed tool cards are not reconstructed after reloading, and an existing CLI conversation cannot be imported through the history UI.
- agy 1.2.4 has no documented system-prompt override flag. Complete Claudian instructions are appended as labeled application context after the user input, preserving native slash invocation. This is not a system-role override.
- Chat turns use native `--mode accept-edits` with the current vault as both the working directory and an explicit `--add-dir` workspace, including resumed conversations. agy 1.2.4 does not grant native reads from cwd alone. Together these options let each vault read, create and edit its own files without an unavailable interactive diff review. Native permission rules still apply to commands and access outside the vault. The provider does not pass `--dangerously-skip-permissions` or modify global CLI permission settings. Explicit native permission restrictions can still block an operation.
- Interactive approval dialogs, image attachments, forks, rewind, steering, native usage accounting, and inline edit are outside this preview. Restricted auxiliary tool policies are rejected rather than silently weakened. Automatic title generation through Antigravity is therefore unavailable; disable it or use a supported provider.
- Native Skills remain read-only in Claudian. The first discovery starts `agy /skills`; subsequent chats share its cached names/descriptions. `.claudian/cache/antigravity-skills.json` restores that catalog across plugin restarts, scoped to the host, vault and configured CLI environment. Startup uses the last valid list while revalidating in the background. Later chat discovery revalidates at most once every five minutes; after a refresh, reopen a chat to pick up changed Skills. Failed refreshes keep the previous list, and invalid caches fall back to native discovery. Actual slash invocation always goes to agy, never to cached Skill contents. No global Skill links or CLI permissions are modified by installation.
- Verified on macOS with Obsidian 1.13.7 and agy 1.2.4. Windows/Linux are not manually verified.

## Checks

Use Node 24 and the upstream dependency lockfile:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

Do not set `.env.local` to a production vault during development; upstream build scripts can copy bundles to configured destinations.

The default suite runs subprocess fixtures without network access. The opt-in live test creates two fictional native conversations and verifies independent continuation after backend recreation. It requires an authenticated CLI and uses provider quota:

```bash
CLAUDIAN_AGY_LIVE_TEST=1 \
CLAUDIAN_AGY_TEST_VAULT=/absolute/path/to/isolated-test-vault \
CLAUDIAN_AGY_TEST_CLI=/absolute/path/to/agy \
npx jest --runInBand --runTestsByPath tests/integration/providers/antigravity/AntigravityLive.test.ts
```

An optional `CLAUDIAN_AGY_TEST_ENV` supplies explicit CLI environment overrides. No proxy is assumed by the test. Manual acceptance covers model discovery and selection, native Skill completion, visible streaming, Escape cancellation, and reopening a saved conversation after reloading the plugin.

The separate opt-in file-permission test creates two temporary vault directories under `CLAUDIAN_AGY_TEST_VAULT`, verifies native reads with fresh random markers in new and restored sessions, file creation and edits, then checks that reads and writes outside the active vault and an unapproved shell command remain denied. It deletes only its own temporary files. Run it in an isolated directory that has no pre-existing native allow rules for the parent, and leave shell approval at its default:

```bash
CLAUDIAN_AGY_LIVE_WRITE_TEST=1 \
CLAUDIAN_AGY_TEST_VAULT=/absolute/path/to/isolated-test-parent \
CLAUDIAN_AGY_TEST_CLI=/absolute/path/to/agy \
npx jest --runInBand --runTestsByPath tests/integration/providers/antigravity/AntigravityFilePermissionsLive.test.ts
```

The opt-in Skill performance test measures cold native discovery, a second chat's cached lookup, and restoration after workspace-service recreation. It uses isolated cache files, does not execute a Skill, and removes its temporary directory:

```bash
CLAUDIAN_AGY_LIVE_SKILL_TEST=1 \
CLAUDIAN_AGY_TEST_VAULT=/absolute/path/to/isolated-test-parent \
CLAUDIAN_AGY_TEST_CLI=/absolute/path/to/agy \
npx jest --runInBand --runTestsByPath tests/integration/providers/antigravity/AntigravitySkillsLive.test.ts
```

Set `CLAUDIAN_AGY_PERF_OUTPUT` to an optional output JSON path for timings.

## Upstream updates

Keep `upstream` pointing at [YishenTu/claudian](https://github.com/YishenTu/claudian) and `origin` at [Backtthefuture/claudian-antigravity](https://github.com/Backtthefuture/claudian-antigravity). The maintained branch is `antigravity-integration`. For each selected release, create a separate update branch/worktree from this integration branch, merge the verified release tag there, inspect the two registration entry points and provider contract changes, and run all checks above. Re-run the live test and manual acceptance in the isolated vault before replacing a working bundle. Keep the previous installation files for rollback. Do not automatically pull development `main` into the installed plugin.

## Publishing for BRAT

Release versions use the upstream base plus an Antigravity prerelease suffix, starting at `2.2.7-antigravity.1`. Keep `package.json`, the root package in `package-lock.json`, `manifest.json`, and the release tag aligned. Add the minimum supported Obsidian version to `versions.json`.

Push the verified integration commit and a matching version tag to `origin`. The upstream Release workflow runs CI and builds the plugin on GitHub, then creates a **draft** release with `main.js`, `manifest.json`, and `styles.css` as individual assets. Download and validate those assets before publishing the draft as a prerelease. BRAT can install a selected prerelease; a ZIP alone is not the BRAT installation interface. Do not publish a failed or incomplete workflow result.

Protocol references: [headless mode](https://www.antigravity.google/docs/cli/headless/) and [CLI reference](https://www.antigravity.google/docs/cli/reference/).
