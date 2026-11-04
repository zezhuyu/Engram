# Dashboard URL notes CLI smoke record

## Run 3

The controller's authorized live run found that Claude Code could exit successfully while silently omitting the required page read. With the old profile (`-p --restricted --permission-prompts none --tools WebFetch --output-format json --no-session-persistence --disable-slash-commands --strict-mcp-config --setting-sources ""`), WebFetch was denied; the JSON `permission_denials` field named WebFetch and the model answered without fetching. The production profile now adds only `--allowedTools WebFetch`, retaining the existing restricted mode, prompt denial, tool limit, session, settings, and MCP restrictions. The controller verified the fixed flags returned `permission_denials: []` and the Example Domain page content with exit code 0. The redacted result was title `Example Domain`; page content was returned. No additional real CLI invocation was made for this code change.

Date: 2026-11-03. URL: `https://example.com/`. Each CLI was invoked once from a mode-0700 `mktemp` scratch directory using the URL-note production argument profile and the same untrusted-page prompt as the runner. No tokens or raw environment values are recorded.

## Claude Code

- Version: `2.1.308` (`claude --version`)
- Executable: `/opt/homebrew/bin/claude`
- Arguments: `-p --restricted --permission-prompts none --tools WebFetch --output-format json --no-session-persistence --disable-slash-commands --strict-mcp-config --setting-sources "" --bare`
- Exit code: `1`
- Duration: `497 ms`
- Result: `Not logged in · Please run /login`
- Draft: unavailable; the command exited before returning page content. Permission/profile flags were accepted. The host account must log in before Claude can be used.

## Codex CLI

- Version: `codex-cli 0.166.0` (`codex --version`)
- Executable: `/opt/homebrew/bin/codex`
- Arguments used in the single authorized smoke: `exec --skip-git-repo-check --ephemeral --sandbox read-only -c approval_policy="never" -c sandbox_network_access=true -c features.web_search=true --color never -C <private mktemp dir> -o <private mktemp dir>/draft.json -`
- Exit code: `0`
- Duration: `8125 ms`
- Parsed draft: title `Example Domain`; summary `This domain is reserved for documentation examples and is not a service.`; key points: intended for documentation examples; it is not a service; the page advises against relying on it for testing or monitoring; quotes: `This domain is for use in documentation examples`, `This is not a service`.
- CLI warnings: `sandbox_network_access` was ignored, and `features.web_search` is deprecated. Web search nevertheless succeeded using the installed CLI's default live web search. The final argument profile removes both ignored/deprecated keys and uses `-c web_search="live"`, as the warning's migration guidance specifies. The final corrected argument set was not sent in a second real invocation because this task authorized one minimal real check per CLI. Fake CLI coverage exercises the final argument set.

No smoke wrote to the vault. Temporary directories were removed after both invocations. Readiness uses `claude auth status --json` and `codex login status`, exposing only a boolean login state; it never returns account identifiers or raw CLI output.

## Run 2

Date: 2026-11-03. URL: `https://example.com/`. Each CLI was invoked once from a fresh mode-0700 private `mktemp` directory with the final production argument profile and the same untrusted-page prompt as the runner. The profile passed only the allowlisted host environment, login config-home selector, and scratch temp paths. No tokens or raw environment values are recorded.

### Claude Code

- Version: `2.1.308` (`claude --version`)
- Readiness: `claude auth status --json` reported `loggedIn: true`; readiness agrees that the local OAuth login is present. Raw status fields are intentionally not recorded.
- Arguments: `-p --restricted --permission-prompts none --tools WebFetch --output-format json --no-session-persistence --disable-slash-commands --strict-mcp-config --setting-sources ""`
- Exit code: `1`
- Duration: `1120 ms`
- Result: the process authenticated far enough to receive an Anthropic API response, then exited before any model call with `api_error_status: 429`, `api_error_origin: first_party`, `api_error: usage_limit_reached`; result text: `You've hit your session limit · resets 6:10pm (America/Toronto)`.
- Draft: unavailable; zero input and output tokens were reported. This is an account session-limit response, not an authentication failure, so the login fix UI is not applicable. No permission flags were weakened.
- CLI warnings: none on stderr. The JSON response carried the API error described above.

### Codex CLI

- Version: `codex-cli 0.166.0` (`codex --version`)
- Arguments: `exec --skip-git-repo-check --ephemeral --ignore-user-config --sandbox read-only -c approval_policy="never" -c web_search="live" --color never -C <private mktemp dir> -o <private mktemp dir>/draft.json -`
- Exit code: `0`
- Duration: `10107 ms`
- Parsed draft: title `Example Domain`; summary `The domain is available for documentation examples without permission and should not be relied on for testing or monitoring.`; key points: usable for documentation examples; it is not a service; do not rely on it for testing or monitoring; quotes: `This domain is for use in documentation examples without needing permission.`, `This is not a service`.
- CLI warnings: none. Stderr contained the normal CLI run banner and model/tool progress only.

Both scratch directories were removed after the invocations. No smoke wrote to the vault.
