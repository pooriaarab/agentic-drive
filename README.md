# agentic-drive

[![npm version](https://img.shields.io/npm/v/agentic-drive)](https://www.npmjs.com/package/agentic-drive)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-drive) · [Source](https://github.com/pooriaarab/agentic-drive) · [Support](https://github.com/pooriaarab/agentic-drive/issues)

Store, sort, and share files and folders.

> Status: early. The library, CLI, MCP server, and HTTP API work. It is not on npm yet.
> Sharing and the web UI are not built yet.

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

## HTTP API

A Cloudflare Worker (Hono) serves `/api/v1/drive` and mirrors the CLI. It uses D1 and R2
through the shared adapters of `agentic-identity`.

```sh
npx wrangler secret put DRIVE_API_TOKENS   # {"<token of 32+ characters>":{"owner":"u1","actor":"u1","kind":"human"}}
npx wrangler secret put DRIVE_URL_SECRET   # 32 bytes or more. It signs download URLs.
npx wrangler secret put DRIVE_PUBLIC_URL   # The origin of the Worker, such as https://drive.example.com
npx wrangler deploy
curl -H "authorization: Bearer <token>" "$URL/api/v1/drive/items?path=/"
```

Routes: `GET /items`, `GET /stat`, `POST /folders`, `PUT /files`, `GET /files`, `GET /url`,
`POST /move`, `POST /trash`, `GET /trash`, `POST /restore`, `POST /purge`, `GET /search`,
`GET /export`, `DELETE /account?confirm=yes`. Without `DRIVE_API_TOKENS`, every request gets 401.
Without `DRIVE_URL_SECRET` or `DRIVE_PUBLIC_URL`, every request gets 503.
Create the R2 bucket with `--jurisdiction eu` and the D1 database with `--location weur`.

## Features

- Folders, files, and typed references to documents in other apps (`docs:<id>`).
- Paths that start with `/`. Anything else is an item id.
- Move, rename, trash, restore, and purge. Trashing a folder hides its whole tree.
- Names compare without regard to case or Unicode form. A clash fails, or renames, or replaces.
- Each item records its size, type, owner, and who made and last changed it, with the actor kind.
- Storage sits behind the `Store` and `Blobs` ports of `agentic-identity`. Tests use its memory adapters. The CLI uses a local file adapter that passes the same contract suites. The Worker uses its D1 and R2 adapters.
- Two live items never share a name in one folder. A claim document holds each name. It is written in the same transaction as the item, and it is deleted when the item goes to the trash.
- `upload()` reads a stream with a size cap, finds the type from the first bytes, and stores a SHA-256 hash.
- `downloadUrl()` returns a signed URL. The Worker verifies it and serves the bytes as an attachment with a safe type, so the link holder cannot change how the bytes are served. A link lasts 15 minutes by default and 1 hour at most. Trashing a file does not revoke a link already issued.
- `search()` finds live items by name, type, kind, size, and who made them.
- `buildExport()` writes everything one owner has to a zip with a `manifest.json`. Trashed items are flagged. Entries are named by item id. A file whose bytes are gone is marked `missing`.
- `deleteAll()` deletes all items and bytes of one owner for good. Only the owner can call it.
- A `can()` hook decides who may read, write, or delete. The default allows the owner only.

## Limits

- This release moves drive onto the shared ports. It keeps no old data: the Worker reads the `store_docs` table (not `docs`), and the CLI reads `store.jsonl` (not `store.json`). There is no import yet, and no claim backfill. Drive is version 0.0.0.
- Uploads buffer the stream in memory up to the cap. The default cap is 25 MiB.
- A signed URL serves an attachment without a file name. The shared port cannot sign a file name yet. That comes with agentic-identity 0.2.0.
- Local file blobs return a `file:` URL that nothing serves or checks.
- Blob writes are not conditional yet. Conditional writes (`ifMatch`, `ifNoneMatch`) come with agentic-identity 0.2.0. Drive then writes a new blob only when its key is free.
- Only `upload()` enforces the size cap. A caller of `putFile()` must check size first.
- A claimed type that a browser would run (HTML, SVG, scripts) is stored as `application/octet-stream`.
- The file adapters allow one process at a time.
- The MCP `drive_export` tool writes a new `.zip` into `<dir>/exports` and never overwrites a file. It takes a plain file name, not a path.
- Hard delete removes blobs first and then rows. If a blob delete fails, the call throws and the same call can run again.
- The export holds every file in memory. A very large drive needs a streaming export, which is not built yet.
- The zip export stores entries without compression and has no Zip64 support.
- No access log for personal data yet. That comes with agentic-identity.
- The D1 store checks every document a transaction read. If another Worker changed one, the transaction runs again, and after 50 tries it fails with a `BUSY` error.
- The D1 store keeps one generic table. A busy deployment needs an expression index on `owner` and `parentId`.
- `region: "eu"` on the D1 and R2 adapters is a promise made at deploy time. The D1 adapter refuses a query that a non-EU region served. The code cannot check where the bucket lives.
- Every API token is at least 32 characters. Its grant names an owner, an actor id, and an actor kind. A grant with a missing part gets 401.
- Tokens in `DRIVE_API_TOKENS` are a stopgap for sign-in. OIDC comes with agentic-identity.
- No sharing or roles yet. Roles come from agentic-identity.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
