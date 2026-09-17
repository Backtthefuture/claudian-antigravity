# Antigravity provider

- Use documented `agy --print --output-format stream-json` events for live execution. Bind continuation to the returned conversation ID; never use global `--continue` or infer the latest session from disk.
- Native headless mode cannot accept interactive permission replies. Respect the native permission policy, report denials, and reject unsupported tool policies. Do not silently add `--dangerously-skip-permissions`.
- Local exception to the shared system-prompt transport invariant: agy has no system-prompt override flag. Append the complete shared instructions as a labeled application-context section after the user's text, preserving an initial native slash command. This is prompt context, not an actual system-role replacement. Do not change the accepted-input ledger. Revisit when agy exposes native system instructions.
- Native transcript replay is not a public CLI API. Persist a provider-owned display snapshot through `buildPersistedProviderState`; never read or modify agy's private databases. Snapshots are for display, not replay into a different native session.
- Model and Skill discovery are independent read-only metadata subprocesses. Do not create a chat session for discovery or enable discovered models without user selection.
