# agentic-drive

[![npm version](https://img.shields.io/npm/v/agentic-drive)](https://www.npmjs.com/package/agentic-drive)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-drive) · [Source](https://github.com/pooriaarab/agentic-drive) · [Support](https://github.com/pooriaarab/agentic-drive/issues)

Store, sort, and share files and folders.

> Status: early. The library, CLI, and MCP server work. It is not on npm yet.
> The HTTP API and sharing are not built yet.

## Install

```sh
npm install agentic-drive
```

## Quick start

```ts
import { createDrive, createFileStore, createFileBlobs } from "agentic-drive";

const drive = createDrive({ store: createFileStore("./data/db"), blobs: createFileBlobs("./data/blobs") });
const me = { owner: "u1", actor: { id: "u1", kind: "human" as const } };

await drive.mkdir(me, "/reports/2026", { parents: true });
await drive.putFile(me, "/reports/2026/q1.txt", new TextEncoder().encode("hello"), { mime: "text/plain" });
await drive.putRef(me, "/reports/plan", "docs:abc123");
await drive.move(me, "/reports/plan", "/reports/2026");
await drive.trash(me, "/reports/2026");
```

## CLI and MCP

```sh
npx agentic-drive mkdir -p /reports
npx agentic-drive upload ./q1.pdf /reports/
npx agentic-drive search --name q1
npx agentic-drive export ./everything.zip
npx agentic-drive mcp
```

Every command prints JSON. A failure prints `{"error":{"code","message"}}` on stderr and exits 1.
Set `--dir`, `--owner`, `--actor`, and `--actor-kind` (or the `AGENTIC_DRIVE_*` variables).
An agent sets `--actor-kind agent_of_human`. Each item then records that a machine made it.

## Features

- Folders, files, and typed references to documents in other apps (`docs:<id>`).
- Paths that start with `/`. Anything else is an item id.
- Move, rename, trash, restore, and purge. Trashing a folder hides its whole tree.
- Names compare without regard to case or Unicode form. A clash fails, or renames, or replaces.
- Each item records its size, type, owner, and who made and last changed it, with the actor kind.
- Storage sits behind `Store` and `Blobs` shapes. Memory and local file adapters ship now.
- `upload()` reads a stream with a size cap, finds the type from the first bytes, and stores a SHA-256 hash.
- `downloadUrl()` returns a signed URL. The R2 adapter signs with AWS Signature V4 for the `eu` jurisdiction. A link lasts 15 minutes by default and 1 hour at most. It always serves an attachment with the stored type. Trashing a file does not revoke a link already issued.
- `search()` finds live items by name, type, kind, size, and who made them.
- `buildExport()` writes everything one owner has to a zip with a `manifest.json`. Trashed items are flagged. Entries are named by item id. A file whose bytes are gone is marked `missing`.
- `deleteAll()` deletes all items and bytes of one owner for good. Only the owner can call it.
- A `can()` hook decides who may read, write, or delete. The default allows the owner only.

## Limits

- Uploads buffer the stream in memory up to the cap. The default cap is 25 MiB.
- The R2 adapter needs an R2 API token for signed URLs. A bucket binding cannot sign.
- Local file blobs have no signed URLs.
- Only `upload()` enforces the size cap. A caller of `putFile()` must check size first.
- A claimed type that a browser would run (HTML, SVG, scripts) is stored as `application/octet-stream`.
- The file adapters allow one process at a time.
- The MCP `drive_export` tool writes a new `.zip` into `<dir>/exports` and never overwrites a file. It takes a plain file name, not a path.
- Hard delete removes blobs first and then rows. If a blob delete fails, the call throws and the same call can run again.
- The export holds every file in memory. A very large drive needs a streaming export, which is not built yet.
- The zip export stores entries without compression and has no Zip64 support.
- No access log for personal data yet. That comes with agentic-identity.
- No sharing or roles yet. Roles come from agentic-identity.
- The `Store` and `Blobs` shapes are a local copy. They move to agentic-identity later.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
