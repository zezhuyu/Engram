# ADR 0001: Preserve Markdown authority and local transactions

Accepted: immutable Markdown revisions plus the committed journal define accepted knowledge. Current views, head pointers and SQLite are derivatives. Restore and delete create revisions, and original imports preserve bytes.

This meets inspectability and recovery requirements without a database-only canonical format. LocalObjectStore uses POSIX filesystem primitives and a single writer lock. Remote object-store/search contracts are retained, but this MVP does not implement S3 or PostgreSQL. Distributed commits need a new coordination design; the interface alone does not imply remote transaction safety.
