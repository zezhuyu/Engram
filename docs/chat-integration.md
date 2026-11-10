# Universal AI chat integration (BETA)

Engram stores imported and owned-client chat messages as ordinary journaled, workspace-scoped Markdown documents. Search indexes are rebuildable. Use an owner-provisioned provider account ID; an account name in an export is never trusted as identity. Keep source exports private and delete them yourself after import if desired: the importer records a source hash and does not copy the archive into the vault by default.

## ChatGPT connector memory spaces

The reserved `personal` workspace is the shared memory for every connected chat AI, including ChatGPT, Claude, and Gemini. Its `chat` collection holds live conversations; its `preferences` collection holds accepted user preference and insight revisions. Both collections are created lazily. The workspace is created on the first connector Save or Start when missing. Chat-specific conversation metadata and project bindings remain in the chat integration layer; they use the same Engram database and Vault commit path as other memory.

ChatGPT may omit the `workspace` tool argument to use `personal`, or name another currently reachable workspace shown in the dashboard. “Allow any workspace by name” is enabled by default, so project workspaces do not need individual gateway rows. The gateway validates the lowercase workspace name, looks it up against the credential's readable-workspace list, and forces the corresponding workspace scope. It rejects caller-supplied scope or collection overrides. Unknown and inaccessible names receive the same generic refusal. Explicit dashboard rows take precedence and can bind a friendly name to a fixed workspace and optional collection.

The dedicated gateway credential can read and write reachable workspaces by name, plus read/write the reserved global `profile` and `user-insight` names. The connector-wide **ChatGPT may write** toggle and each per-workspace write switch default ON; turning the global switch off denies all gateway write tools. Since names are not secrets, anyone who can reach the tunnel and has its inbound key can read and write the memory exposed by that connector. Keep the tunnel key private and turn writes off when they are not needed. Writes are ordinary Vault revisions attributed to the gateway credential; restore an earlier revision through the normal Vault restore operation. The credential stays in the gateway's private 0600 secret file and is never returned in dashboard status/API output.

Live gateway conversations use one document per conversation in `personal/chat/`; turns append as immutable revisions. Calling `engram_chat_record` without `conversationId` starts a new conversation and returns the ID. For a later turn in that same chat, the model must pass the returned ID. It must start a new conversation unless the user explicitly asks to continue a specific one; it must not infer continuation from topic, title, or similarity. Replaying the same `turnId` and content is idempotent, while an unknown explicit ID is refused. `engram_chat_recent` and `engram_chat_find` return bounded, ACL-checked discovery metadata so the model can offer prior conversations when asked. `engram_chat_record` accepts inert, bounded, redacted text. `engram_preference_record` stores explicit user statements as the existing `user_insight` kind with category, stable `preferenceKey`, evidence/review metadata, and preserved revisions in `personal/preferences/`; accepted profile projections remain deterministic. The existing verified standalone import route keeps its current collection and provenance; no records are moved. `engram_project_projection` returns a ranked, scoped, deduplicated projection under the caller's requested token cap instead of exposing the database wholesale. Imported documents and chat text remain untrusted data and are never instructions.

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

The prior OpenAI OAuth/public-URL connector proposal is superseded by the dashboard-managed private tunnel plus keyed gateway described in `docs/remote-client-setup.md`. That path uses no public URL and no transport OAuth. The real tunnel-client and ChatGPT account were not contacted for implementation verification. Claude Code/Desktop can connect through local stdio with no URL. Claude.ai custom connectors are separate: their requests originate from Anthropic's cloud and need an owner-operated public HTTPS endpoint. Engram does not publish the machine or create ingress. Its optional fixed-header key is scoped to the configured gateway rows; anyone holding it can use those scopes. Claude.ai and Desktop were not contacted or restarted for this implementation. Do not point Claude at an OpenAI-only tunnel. See [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) and [Claude connector network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

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

## Global wiki access

The keyed ChatGPT gateway also reserves the name `wiki` for `global:wiki`. It is read-enabled by default; the connector-wide **ChatGPT may write** setting controls wiki writes. ChatGPT can create or patch pages through normal versioned operations, and the gateway does not expose wiki deletion. Credentials need `global:wiki:read` to search/get pages; an actor with only workspace grants cannot see wiki titles, counts, snippets, or results. Workspace-scoped queries remain confined to their requested workspace. Curated imports and safe retirement of old workspace copies are documented in [wiki import](wiki-import.md).
