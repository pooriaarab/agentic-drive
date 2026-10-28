# agentic-drive

[![npm version](https://img.shields.io/npm/v/agentic-drive)](https://www.npmjs.com/package/agentic-drive)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-drive) · [Source](https://github.com/pooriaarab/agentic-drive) · [Support](https://github.com/pooriaarab/agentic-drive/issues)

Store, sort, and share files and folders.

> Status: early. The drive model and uploads work as a library. It is not on npm yet.
> The CLI, MCP server, HTTP API, search, and sharing are not built yet.

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

## Features

- Folders, files, and typed references to documents in other apps (`docs:<id>`).
- Paths that start with `/`. Anything else is an item id.
- Move, rename, trash, restore, and purge. Trashing a folder hides its whole tree.
- Names compare without regard to case or Unicode form. A clash fails, or renames, or replaces.
- Each item records its size, type, owner, and who made and last changed it, with the actor kind.
- Storage sits behind `Store` and `Blobs` shapes. Memory and local file adapters ship now.
- `upload()` reads a stream with a size cap, finds the type from the first bytes, and stores a SHA-256 hash.
- `downloadUrl()` returns a signed URL. The R2 adapter signs with AWS Signature V4 for the `eu` jurisdiction.
- A `can()` hook decides who may read, write, or delete. The default allows the owner only.

## Limits

- Uploads buffer the stream in memory up to the cap. The default cap is 25 MiB.
- The R2 adapter needs an R2 API token for signed URLs. A bucket binding cannot sign.
- Local file blobs have no signed URLs.
- The file adapters allow one process at a time.
- No sharing or roles yet. Roles come from agentic-identity.
- The `Store` and `Blobs` shapes are a local copy. They move to agentic-identity later.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
