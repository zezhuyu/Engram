# Universal AI chat integration (BETA)

Engram stores imported and owned-client chat messages as ordinary journaled, workspace-scoped Markdown documents. Search indexes are rebuildable. Use an owner-provisioned provider account ID; an account name in an export is never trusted as identity. Keep source exports private and delete them yourself after import if desired: the importer records a source hash and does not copy the archive into the vault by default.

## Import and project routing

Create/link existing workspaces with the owner CLI:

```sh
mdb chat account register --provider chatgpt --account chatgpt-personal
mdb chat project link --provider chatgpt --account chatgpt-personal --project external-project-id --workspace product-work
mdb chat account register --provider claude --account claude-personal
mdb chat project link --provider claude --account claude-personal --project claude-project-id --workspace product-work
```

To make a new workspace and link a provider project, use `chat project create` with `--workspace`, `--name`, and optionally `--description`. Names are labels; provider/account/project IDs are the binding key. Many provider projects can map to one Engram workspace. `remap` requires the expected binding version. `unlink` affects future routing; it does not move or delete prior messages.

For example, two provider projects can share one existing workspace while a third provider project gets a new workspace:

```sh
mdb chat account register --provider chatgpt --account work-chatgpt
mdb chat account register --provider claude --account work-claude
mdb chat account register --provider gemini --account work-gemini
mdb chat project link --provider chatgpt --account work-chatgpt --project gpt-project-id --workspace product-work
mdb chat project link --provider claude --account work-claude --project claude-project-id --workspace product-work
mdb chat project create --provider gemini --account work-gemini --project gemini-project-id --workspace gemini-work --name "Gemini project"
```

Preview an export before committing it. Choose `standalone` only when the source confirms the conversation is not in a project. Project conversations route through their explicit link; an unmapped member project remains pending, and `unknown` membership requires review.

```sh
mdb chat import preview --provider chatgpt --account chatgpt-personal --format chatgpt-zip --file ./conversations.zip --membership unknown
mdb chat import run --provider chatgpt --account chatgpt-personal --format chatgpt-zip --file ./conversations.zip --membership unknown --batch chatgpt-export-2026-10
mdb chat import status --batch chatgpt-export-2026-10
mdb chat list --provider chatgpt --account chatgpt-personal --workspace product-work
mdb chat search --provider chatgpt --account chatgpt-personal --workspace product-work --query "release plan"
mdb chat get --provider chatgpt --account chatgpt-personal --workspace product-work --conversation conversation-id
```

Use the provider named by the source export and preview before writing. The following commands show the supported adapter entry points; they do not imply that each provider schema has been qualified against a live account export:

```sh
# ChatGPT export archive or conversations JSON
mdb chat import preview --provider chatgpt --account chatgpt-personal --format chatgpt-zip --file ./conversations.zip --membership unknown
# Claude export archive or JSON
mdb chat import preview --provider claude --account claude-personal --format claude-zip --file ./claude-export.zip --membership unknown
# Candidate Gemini Takeout activity adapter (schema remains provisional)
mdb chat import preview --provider gemini --account gemini-personal --format gemini-takeout-zip --file ./takeout.zip --membership unknown
# Portable generic conversion when a vendor export is not a verified adapter variant.
# Register this as a generic source: conversion does not claim provider-native provenance.
mdb chat account register --provider generic --account converted-history
mdb chat import preview --provider generic --account converted-history --format generic-jsonl --file ./converted-history.jsonl --membership unknown
```

For a standalone conversation, set `--membership standalone` only when the export or a user-reviewed mapping establishes that fact. A known project requires `--membership member` and an active link; an unknown project must stay `unknown` for review. Once a batch is routed, its source/account/project provenance is retained with each message.

Formats accepted by the current CLI: `generic-json`, `generic-jsonl`, `chatgpt-json`, `chatgpt-zip`, `claude-json`, `claude-zip`, `gemini-takeout-json`, and `gemini-takeout-zip`. The ChatGPT ZIP adapter accepts bounded `conversations.json` and numbered `conversations-N.json` members, in numeric order, under one aggregate 64 MiB selected-member limit; this variant is synthetic-fixture tested, not validated against a real account export. The Claude and Gemini ZIP adapters select one bounded JSON member; Gemini's selected Takeout path and row schema remain provisional until checked against a real authorized export. Use generic JSON/JSONL as the portable conversion fallback for an unverified vendor variant. JSON imports are bounded; JSONL is line-streamed. Resume requires the original batch ID and its durable checkpoint. `chat import status` returns the committed checkpoint and metadata-only per-record warnings. Never place private exports in source control or support tickets.

The portable generic format is schema version 1:

```json
{"schemaVersion":1,"conversations":[{"id":"conversation-id","title":"Optional","projectId":"optional-provider-project-id","messages":[{"id":"message-id","role":"user","text":"message body","timestamp":"2026-10-28T10:00:00Z","parentMessageId":"optional-parent","branchId":"optional-branch"}]}]}
```

JSONL uses one normalized message per line with `conversationId`, `id`, `role`, `text`, and optional project/time/branch fields. Example:

```jsonl
{"conversationId":"conversation-id","id":"message-id","role":"user","text":"message body","timestamp":"2026-10-28T10:00:00Z"}
```

When converting a provider export to generic JSON/JSONL, preserve the original provider, account, project, message, timestamp, and branch details in the conversion process where the source supplies them. Import through `--provider generic` records the registered generic account as the trusted source identity; it does not independently prove the upstream vendor identity.

## Search, review, and cross-project evidence

`chat list`, `chat get`, `chat search`, their SDK APIs, and the `mdb_chat_*` / `engram_chat_*` MCP read tools use existing Vault ACLs. Conversation results are paginated and bounded. An MCP connection does not grant workspace access; grant the actor access separately.

Imported user and assistant speakers are stored separately. Profile extraction treats only the user's own message as user-conversation evidence. For a user-directed, deterministic cross-project preference proposal, the SDK exposes `proposeCrossProjectChatInsight`. It requires two to ten current user-message revisions from at least two active provider/account/project bindings, and each selected exact span must contain the entire proposed claim verbatim. It rejects assistant messages, inaccessible or changed/deleted sources, revoked accounts, inactive project links, credentials, and sensitive spans. It does not send those spans to a model and it only creates a **pending** proposal; ordinary Profile review must approve it. This deliberately narrow path does not claim general semantic cross-project extraction. A model-generated cross-project claim must use the existing evidence/critic/review path and remain review-only unless separate quality gates pass.

Deleting/correcting a source does not rewrite immutable history. New cross-project proposals reject stale source revisions. Existing derived items continue to follow Engram's standard ACL, evidence review, and purge/invalidation behavior; users should review existing proposals and accepted insights after deleting source messages.

## Owned-client passive capture

An Engram-controlled client may register with explicit consent and a trusted source account:

```sh
mdb chat client register --provider chatgpt --account chatgpt-personal --principal my-chat-client --consent
```

The host must call the SDK `captureChatTurn` with trusted registration identity and both user/assistant turn text. The capture service redacts secrets, appends to Engram's durable spool, routes using the account/project registry, and replays idempotently after transient failure. `unknown` membership stays queued for review; it is not Personal. An interrupted atomic enqueue can leave an unpublished queue temporary file; queue statistics count only committed `.json` records, and a later enqueue/drain reclaims only the exact PID-tagged temporary files whose owner process is confirmed dead. Legacy UUID-only temporary names are left untouched because their owner cannot be established. This interface is for an Engram-controlled/instrumented client. It does not attach itself to another vendor's native chat UI.

## Provider capability and evidence matrix

| Provider | Historical export/import | Explicit MCP | Native web UI passive capture | Evidence/status |
|---|---|---|---|---|
| ChatGPT | Official account export is documented; adapter handles the `conversations.json` mapping tree and ZIP fixture. | Engram MCP chat read and memory tools exist. Actual ChatGPT account connection has not been run here. | Unsupported/unverified; no official per-turn event stream was tested. | Export format is synthetic-fixture tested, not validated against a user-provided real export. OpenAI documents ChatGPT web custom MCP for Business and Enterprise/Edu full MCP, with Pro limited to read/fetch; workspace admins/owners control creation and publishing. See [OpenAI export](https://help.openai.com/en/articles/20001279-exporting-data-from-a-chatgpt-edu-workspace), [general ChatGPT data export](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data), and [ChatGPT custom MCP requirements](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt). |
| Claude | Official data export is documented; adapter handles `chat_messages` and a synthetic ZIP member fixture. | Engram MCP tools exist. Actual Claude.ai connector was not configured or tested. | Unsupported/unverified; remote connector support is not an event stream into Engram. | Export format is synthetic-fixture tested, not validated against a real account export. See [Claude export](https://support.claude.com/en/articles/9450526-export-your-claude-data) and [Claude remote MCP connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). |
| Gemini | Google documents a Takeout export including Gemini Apps/My Activity; current parser handles a candidate prompt-activity row shape and preserves prompt-only semantics. | Engram MCP tools are provider-neutral; no native Gemini web connector was tested. | Unsupported/unverified. | **Direct Takeout schema is provisional/BLOCKED**: no real archive fixture was available. Use generic JSON/JSONL conversion until a user-authorized actual export validates the format. See [Gemini Apps export](https://support.google.com/gemini/answer/16920332?hl=en-GB). |
| Generic | Schema v1 JSON and JSONL are implemented and synthetic end-to-end tested. | Same Engram MCP operations. | Only through an explicitly instrumented/owned client. | Supported portable conversion path; synthetic tests do not validate third-party export variants. |

The OpenAI Secure MCP Tunnel and Claude's remote connector are distinct transports. Engram's MCP service remains loopback HTTP by default. The tunnel/client, public endpoint and account authorization have not been activated as part of this task. Claude remote connectors originate from Anthropic infrastructure and therefore need a separately approved publicly reachable HTTPS endpoint or another supported gateway; do not point it at an OpenAI-only tunnel. See [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) and [Claude connector network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## Migration, retention, and rollback

Existing vaults need no bulk migration. Creating `personal` and owner-provisioned account/project metadata are additive journaled Vault writes. Back up first. Preview parses without writes; import commits each message through Vault and advances its durable resume checkpoint at bounded 100-record intervals and at the end of each invocation. A crash can replay at most 99 records; deterministic message identity and content/provenance checks make replay idempotent before the checkpoint advances. Roll back routing by versioned unlink/remap; preserve the immutable imported revisions unless a separately authorized purge is required. Re-importing identical content and source provenance is idempotent. A correction to message content or source provenance (such as role, timestamp, parent/branch, project binding, or title) creates a new immutable revision; the current role search tag is updated with the revision. Do not overwrite revision files. Search indexes can be rebuilt from canonical Markdown/journal state.

Imported conversations remain until an authorized user deletes/purges them under normal Vault policy. Source archives and attachments are not automatically downloaded. Export ZIP contents are parsed in memory under archive limits, not extracted to arbitrary paths. HTTP(S) attachment URLs are retained as inert references only; Engram never fetches them. Provider-specific structured blocks (for example ChatGPT image asset pointers and Claude thinking/tool blocks) are preserved as inert structured metadata when bounded and recognizable; unsupported or oversized parts receive stable warnings.

### Imported message visibility

Imports preserve system, tool, assistant, and user roles. A provider's `is_visually_hidden_from_conversation` marker is retained as `metadata.hidden`. By default, conversation list/get/search returns only non-hidden `user` and `assistant` messages. An authorized caller can explicitly request `includeNonUser: true` to inspect hidden, system, tool, and other roles; normal Vault workspace/collection ACL checks still run before content is read or returned. This import policy is specific to conversation retrieval and does not delete or rewrite source messages. `get` returns at most 1,000 messages per page in stable `(source timestamp, external message ID, object ID)` order and returns an opaque `nextCursor` for later pages. Cursors are filter-bound and are re-authorized against the caller's current ACL on every request.

## Current limitations

- No real ChatGPT, Claude, or Gemini user export was supplied; adapter schema tests use synthetic fixtures.
- Gemini direct Takeout parsing is provisional and not qualified; generic conversion is the fallback.
- No ChatGPT or Claude hosted MCP account invocation has been tested. OAuth/tunnel/network authorization is external.
- Native ChatGPT/Claude/Gemini UI event capture is unsupported/unverified. Only an owned/instrumented client has tested passive capture.
- Cross-project insight creation is user-directed and requires exact repeated wording. It is not unattended model extraction, and it remains pending human review.
- 1K/10K/100K scale, rollback of a live imported history, and full `verify:all` are reported separately in `verification/chat-integration-progress.md` and `verification/chat-integration-final.md`.
- Engram remains BETA; existing Dream, Preferences, durability, performance, release, and production gates are not promoted by this integration.
