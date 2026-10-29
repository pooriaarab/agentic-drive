# agentic-drive

[![npm version](https://img.shields.io/npm/v/agentic-drive)](https://www.npmjs.com/package/agentic-drive)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-drive) · [Source](https://github.com/pooriaarab/agentic-drive) · [Support](https://github.com/pooriaarab/agentic-drive/issues)

Store, sort, and share files and folders.

> Status: early. The library, CLI, MCP server, and HTTP API work, with sharing in the SDK and the HTTP API.
> The web UI is not built yet.

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
npx wrangler secret put DRIVE_URL_SECRET   # 32 bytes or more. It signs download URLs.
npx wrangler secret put DRIVE_PUBLIC_URL   # The origin of the Worker, such as https://drive.example.com
npx wrangler deploy
curl -H "authorization: Bearer <token>" "$URL/api/v1/drive/items?path=/"
```

Routes: `GET /items`, `GET /stat`, `POST /folders`, `PUT /files`, `GET /files`, `GET /url`,
`POST /move`, `POST /trash`, `GET /trash`, `POST /restore`, `POST /purge`, `GET /search`,
`GET /export`, `DELETE /account?confirm=yes`, `GET /home`, `POST /documents`, `DELETE /documents?ref=`.
Sign in with a bearer token from agentic-identity. The token is a credential in the `credentials` collection of
the same D1 database, and it names a principal in `principals`. The Worker resolves the whole delegation chain on
every request. A missing, expired, or revoked credential, or a revoked or expired principal (or one above it), gets 401.
A session cookie is refused: only a bearer token counts. An agent acts in its owner's drive with the narrower scopes of its grant.
Scopes are `drive:read`, `drive:write`, and `drive:admin`.

Sharing routes: `GET /shares?path=`, `POST /shares`, `DELETE /shares?path=&subjectId=&subjectKind=`, `POST /invites`,
`POST /invites/accept`, `POST /links`, `DELETE /links?id=`. A link visitor reads with the header
`x-link-token` on `GET /shared/:id`, `GET /shared/:id/items`, and `GET /shared/:id/content`.
Name a shared item by its id. A path can start at a folder id: `<folder id>/notes/a.txt`.
Without `DRIVE_URL_SECRET` or `DRIVE_PUBLIC_URL`, every request gets 503.
Create the R2 bucket with `--jurisdiction eu` and the D1 database with `--location weur`.
The Worker declares region `eu` and refuses a D1 query that a non-EU region served. `DRIVE_REGION=unknown` turns this off for local runs.

## Features

- Folders, files, and typed references to documents in other apps (`docs:<id>`).
- Paths that start with `/`. Anything else is an item id.
- Move, rename, trash, restore, and purge. Trashing a folder hides its whole tree.
- Names compare without regard to case or Unicode form. A clash fails, or renames, or replaces.
- Each item records its size, type, owner, and who made and last changed it, with the actor kind.
- Storage sits behind the `Store` and `Blobs` ports of `agentic-identity`. Tests use its memory adapters. The CLI uses a local file adapter that passes the same contract suites. The Worker uses its D1 and R2 adapters.
- Roles: viewer, commenter, editor, owner. A role on a folder reaches everything under it, and follows an item that moves. Identity decides every request through `can()`, which also writes the audit entry. A caller who cannot read an item gets `NOT_FOUND`. A caller who can read it but not change it gets `FORBIDDEN`. Editors write and trash. An item takes the roles of its new folder, so moving an item into a folder where the caller is owner needs owner on the item. Only owners share, purge, and read the share list.
- Share by a subject (`{ kind: "human" | "agent", id }`), by invite (an email for a person, a handle for an agent), or by link with a role, an expiry, and an optional sign-in. The SDK calls are `shareWith`, `unshare`, `invite`, `acceptInvite`, `createLink`, `revokeLink`, `shares`, `openShared`, `listShared`, and `readShared`.
- Two live items never share a name in one folder. A claim document holds each name. It is written in the same transaction as the item, and it is deleted when the item goes to the trash.
- `upload()` reads a stream with a size cap, finds the type from the first bytes, and stores a SHA-256 hash.
- `downloadUrl()` returns a signed URL. The URL signs an attachment header with the file name and the stored type. The Worker verifies it and serves the bytes with those headers, so the link holder cannot change how the bytes are served. A link lasts 15 minutes by default and 1 hour at most. Trashing a file does not revoke a link already issued.
- `search()` finds live items by name, type, kind, size, and who made them.
- App documents: an app calls `registerDocument({ ref: "docs:<id>", name, folder })` to put a document in the drive, and `forgetDocument(ref)` when it deletes the document. `home({ app })` lists files and every app's documents together, newest change first, with a count per app. `search({ app })` filters the same way. The CLI has `home`, `register`, and `forget`. The MCP server has `drive_home`, `drive_register_document`, and `drive_forget_document`.
- `buildExport()` writes everything one person has to a zip with a `manifest.json` (format version 2). It names the person by id and kind. It lists the person's own items (trashed ones are flagged, and a file whose bytes are gone is marked `missing`). For the person in person it also lists the ids of what they or their agents made or changed in other drives (no names, and nothing of the people who own them), the shares they hold, the invites they sent, and the audit entries of what they and their agents did. An agent gets `partial: true` and none of that. Invitee emails and link tokens are never in it. Entries are named by item id.
- `erasePerson()` erases a person for good, and only the person in person can call it (the CLI `delete-all` and `DELETE /account` call it). It deletes their drive with all its shares, the shares they hold, and the invites they or their agents sent, on drive items only: the grants of other apps stay for those apps and for identity. What they or their agents made in other drives stays, because it belongs to those drives: the id becomes `erased`, and the kind stays, so machine-made work keeps its label. Agents are found through the `principals` collection, as identity finds them: an agent with its own identity names the person as `ownerId`, and a delegated agent names its parent. An agent with its own identity belongs to the person, and so does its drive: erase deletes it, and the export lists its items (no bytes). A person with more than 1000 agents cannot be erased here: the call fails and deletes nothing more. The audit trail stays: it holds ids and kinds only. A failed call can run again. `deleteAll()` is the drive part alone.
- A `can()` hook decides who may read, write, or delete. Without `sharing`, the default allows the owner only.

## Limits

- Erase does not delete what identity keeps about the person: their principal, credentials, and sign-in record. Identity erases those. An invite that names only an email, sent by someone else, stays until it expires.
- Items made before drive kept `createdById` and `updatedById` have no such fields, so an export or an erase cannot find them. Run `backfillAuthorIds(store, { maxPages: 1 })` on a store of that age, once the old Worker has stopped writing. Each call runs `maxPages` pages of 10 items, and returns a `nextCursor` while items remain. Pass the cursor to the next call until none is returned. Without `maxPages`, one call runs every page, which can exceed a Worker's query cap on a large store.
- There are no retention settings yet, and no per-workspace export. An export covers one person.
- `registerDocument` makes one item per document in a drive. Two calls at the same moment can make two.

- Drive reads the `store_docs` table in D1 and `store.jsonl` in the CLI folder. It does not read older layouts. There is no import and no claim backfill.
- Uploads buffer the stream in memory up to the cap. The default cap is 25 MiB.
- Local file blobs return a `file:` URL that nothing serves or checks.
- Drive writes each new blob only when its key is free (`ifNoneMatch`). A write that finds the key taken fails with `BLOB_EXISTS`.
- Only `upload()` enforces the size cap. A caller of `putFile()` must check size first.
- A claimed type that a browser would run (HTML, SVG, scripts) is stored as `application/octet-stream`.
- The file adapters allow one process at a time.
- The MCP `drive_export` tool writes a new `.zip` into `<dir>/exports` and never overwrites a file. It takes a plain file name, not a path.
- A purge or an erase works in chunks of 25 items (10 with sharing on), and each chunk commits. A Worker call has a cap on database queries, so a very large tree can need several calls. A failed or cut-off call leaves marked items hidden, and the same call finishes the job.
- Hard delete removes blobs first and then rows. If a blob delete fails, the call throws and the same call can run again.
- The export holds every file in memory. A very large drive needs a streaming export, which is not built yet.
- The zip export stores entries without compression and has no Zip64 support.
- No access log for personal data yet. That comes with agentic-identity.
- The D1 store checks every document a transaction read. If another Worker changed one, the transaction runs again, and after 50 tries it fails with a `BUSY` error.
- The D1 store keeps one generic table. A busy deployment needs an expression index on `owner` and `parentId`.
- `region: "eu"` on the D1 and R2 adapters is a promise made at deploy time. The D1 adapter refuses a query that a non-EU region served. The code cannot check where the bucket lives.
- Sharing is on in the Worker and in the SDK (`createDrive({ sharing })`). The CLI and the MCP server work on a local drive with one owner, so they do not share yet.
- Drive writes the `resources` doc of each item itself, in the same transaction, because identity has no call that does it in a transaction. A drive with `sharing` off keeps no such docs. Turn sharing on at the start, or run `backfillResources` after you turn it on.
- An invite sends no message. The caller passes the invite id on.
- Sharing follows a path of 16 resources, the drive root included, so an item sits at most 15 folders deep. A deeper path, move, or restore fails with `TOO_DEEP`. A move or a restore of a folder spends up to 200 queries on its subfolders (never on files), once, outside the transaction, to count its height. A move up or sideways, a rename, and a file need no count. A bigger folder fails with `TOO_MANY_ITEMS`: move its parts one by one. An edit inside the folder while it moves can leave items past the cap. Nobody can then reach them, and moving the folder back up repairs it.
- Every access check writes one audit row, and a transaction that runs again writes its rows again. The audit holds ids and kinds only: no emails and no content.
- Data made before sharing has no `resources` docs, so its owner gets `NOT_FOUND`. Run `backfillResources(store, { maxPages: 1 })` on that store, paged the same way, once the old Worker has stopped writing. See CHANGELOG.md for the order of the upgrade steps.
- A person who is not an owner cannot move an item into their own drive: the move fails with `CROSS_DRIVE`.
## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
