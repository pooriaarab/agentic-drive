# agentic-drive

[![npm version](https://img.shields.io/npm/v/agentic-drive)](https://www.npmjs.com/package/agentic-drive)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-drive) · [Source](https://github.com/pooriaarab/agentic-drive) · [Support](https://github.com/pooriaarab/agentic-drive/issues)

Store, sort, and share files and folders.

> Status: 0.5.0, early. The library, CLI, MCP server, and HTTP API work, with sharing in the SDK and the HTTP API.
> A small web UI works. See [UI](#ui).

## Live demo

A demo Worker runs at https://agentic-drive-demo.hello-fd1.workers.dev. `GET /health` answers 200, and the web UI is served at `/`.
The API needs a bearer token, so a call without one gets 401. The demo holds throwaway data only, and it can be reset at any time.

To redeploy it, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in your shell, then run:

```sh
npm run deploy:demo
```

This uses `wrangler.demo.jsonc` (D1 in `weur`, R2 in the EU jurisdiction, `workers_dev` on). The URL signing secret lives in the Worker:
`openssl rand -hex 32 | npx wrangler secret put DRIVE_URL_SECRET -c wrangler.demo.jsonc`. Deploys are manual. No CI secret is used.

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

Every command except `help`, `--version`, `principal`, and `key` needs a principal. Pass an API key with
`--token <key>` or `AGENTIC_DRIVE_TOKEN`. Prefer the variable: a flag shows in `ps`.
`agentic-identity` resolves the key. The drive belongs to the person at the top of the
principal's chain. An agent key marks each item it makes as made by a machine. A revoked,
expired, or unknown key fails with exit code 3.

```sh
npx agentic-drive principal add alice
export AGENTIC_DRIVE_TOKEN=$(npx agentic-drive key issue alice | jq -r .token)
npx agentic-drive principal add helper --of alice     # an agent of alice
npx agentic-drive key issue helper                    # the key shows once
npx agentic-drive key revoke <key>
npx agentic-drive principal revoke helper             # stops its keys, and its agents
```

`principal` and `key` need no key: anyone who can write to the `--dir` folder can run them.
Set `--dir` (or `AGENTIC_DRIVE_DIR`) to choose the data folder.
The local drive checks the owner only. It does not apply the scopes of an agent key.

```sh
npx agentic-drive mkdir -p /reports
npx agentic-drive upload ./q1.pdf /reports/
npx agentic-drive search --name q1
npx agentic-drive export ./everything.zip
npx agentic-drive mcp
```

Every command prints JSON, except `help`, `--version`, `mcp`, and `download` to `-`. A failure prints `{"error":{"code","message"}}` on stderr and exits 1.
Exit code 2 means bad usage. Exit code 3 means no principal, or a key that is not valid.

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
Without `DRIVE_URL_SECRET` or `DRIVE_PUBLIC_URL`, every API request gets 503. `/health` still answers.
Create the R2 bucket with `--jurisdiction eu` and the D1 database with `--location weur`.
The Worker declares region `eu` and refuses a D1 query that a non-EU region served. `DRIVE_REGION=unknown` turns this off for local runs.

## SDK

`agentic-drive/client` is a typed client for the HTTP API. It uses only `fetch`, so it runs in browsers, Workers, and Node 22.

```ts
import { createClient, DriveApiError } from "agentic-drive/client";

const drive = createClient({ baseUrl: "https://drive.example.com", token: process.env.DRIVE_TOKEN });
await drive.mkdir("/docs", { parents: true });
const file = await drive.upload("/docs/a.txt", "hello", { mime: "text/plain" });
const { data } = await drive.download(file.id);
try {
  await drive.stat("/missing");
} catch (error) {
  if (error instanceof DriveApiError) console.log(error.code, error.status); // NOT_FOUND 404
}
```

- One method for each bearer route and each shared route: `list`, `stat`, `mkdir`, `upload`, `download`, `url`, `move`, `trash`, `listTrash`, `restore`, `purge`, `search`, `export`, `deleteAccount`, `home`, `registerDocument`, `forgetDocument`, `shares`, `share`, `unshare`, `invite`, `acceptInvite`, `createLink`, `revokeLink`, `openShared`, `listShared`, and `readShared`.
- Each method has typed input and output. The client checks the shape of every answer, and `download` checks the bytes against their hash (it needs WebCrypto). `readShared` does not: the Worker sends no hash there. An answer that fails a check throws `BAD_RESPONSE`. `url` gives a signed link that you fetch yourself. The last argument takes `{ signal }` to stop the call with an `AbortSignal`.
- A failed call throws `DriveApiError`. It has the `code` of the API and the HTTP `status`. A call that gets no answer has the code `NETWORK_ERROR` and status 0. An abort stays the abort error of `fetch`. A code that the client does not know gives `BAD_RESPONSE`.
- The client never sends a write again. `retries` (default 0) sends a read (GET) again after a network error or a 502, 503, or 504, with a short wait. A redirect is an error (`BAD_RESPONSE`, with the status of the redirect, or 0 in a browser): set `baseUrl` to the final URL.
- `fetch` is an option, for tests and for runtimes with their own. `openShared`, `listShared`, and `readShared` work without a token, with a `linkToken`.
- A stream body for `upload` is refused by some browsers. The error says so, and nothing is sent. Items from before 0.2.0 need `backfillAuthorIds`, and grants from before 0.3.0 need identity's `migrateGrants`. Without them, an answer that holds one fails with `BAD_RESPONSE`.
- A browser page needs the Worker on its own origin for now: the Worker sends no CORS headers.
- Share with a subject: `share("/pub", { kind: "human", id: "u2" }, "viewer")`.

### Other exports

The root export, `agentic-drive`, also exports these names. The package typings give the type of each one.

- `VERSION` is the package version. `ROOT_ID` is the id of a drive's root folder, `"root"`. `ACTOR_KINDS` lists
  the five principal kinds that `agentic-identity` names.
- `DEFAULT_MAX_BYTES` is the upload cap: 25 MiB (26,214,400 bytes). `sniffMime(head)` returns the type that
  the first bytes name: PNG, JPEG, GIF, PDF, ZIP, gzip, or WebP. It returns `null` for any other bytes.
- `parseName(raw)` returns `{ name, key }`. It normalizes the name to NFC, and `key` is the lowercase name.
  It throws a `DriveError` with the code `INVALID_NAME` for a blank name, `.`, `..`, a lone surrogate, a `/`,
  a control character (U+0000 to U+001F, or U+007F), or a name over 255 bytes in UTF-8. `parseSubject(input)` returns `{ kind, id }` for a valid subject, and throws
  `INVALID_SHARE` for any other input. `subjectKindOf(kind)` returns `human` or `agent`, and throws
  `INVALID_SHARE` for any other kind.
- A `DriveError` has a `code` from `ErrorCode`, such as `NOT_FOUND` or `NAME_TAKEN`.
- `readZip(bytes)` reads a zip that `writeZip` made, with stored (uncompressed) entries only. It returns a `Map`
  from each entry name to its bytes. It throws for a compressed entry. `writeZip(entries, at)` writes a zip with
  one `{ name, data }` entry for each file, and `at` sets the time in milliseconds. It throws for an unsafe
  name, such as one with `..` or a leading `/`.
- The local drive has the functions behind the CLI. `openLocal(dir)` returns `{ drive, store }` for a folder.
  `addPrincipal(store, id, { parent?, scopes? })` makes a principal. `issueKey(store, principalId, label?)`
  returns the key. Keep it: the store keeps no plain copy. `resolveToken(store, token)` returns the caller, or throws `AuthError`
  with the code `UNAUTHENTICATED`. `revokeKey(store, token)` stops one key. `revokePrincipal(store, id)` stops a
  principal, its keys, and every agent below it.
  `publicNode(node, path?)` returns an item without its storage keys and its `purging` flag, and adds `machineMade`. When `path` is
  given, it also adds `path`.

  The local functions trust their caller. Local data is the trust boundary: anyone who can write the folder
  can act as any principal in it.

## UI

The Worker serves a small web UI. It uses the [agentic-design](https://www.npmjs.com/package/agentic-design) package and the typed client of this package (`agentic-drive/client`). It has a folder tree, breadcrumbs, a file list and grid, upload by button or by drag and drop, new folder, rename, move, trash and restore, and a share dialog with roles and a link. An item that an agent made shows a "Created by agent" label while a person is its last editor. "Edited by" names the last editor, a person or an agent. It works with the keyboard. An automated axe check for WCAG 2.2 AA passes on each view in the light and dark themes.

Run it locally:

```sh
npm ci
npm run build:ui
WRANGLER_SEND_METRICS=false npx wrangler dev --local \
  --var DRIVE_PUBLIC_URL:http://127.0.0.1:8787 \
  --var DRIVE_URL_SECRET:<32 or more characters> --var DRIVE_REGION:unknown
```

Open `http://127.0.0.1:8787` and sign in with a bearer token. The tab keeps the token until you close it. A fresh local database has no tokens. `e2e/serve.mjs` shows how to seed a person and an agent.

Test it with `npm run test:e2e`. The test starts `wrangler dev` on a seeded database, drives the UI in Chromium, and runs an axe WCAG 2.2 AA check on each view in both themes. Run `npx playwright install chromium` once first. The run also writes the screenshots in [docs/ui](docs/ui).

Run `npm run build:ui` before `npm run test:e2e` or `wrangler deploy`, because the Worker config names the `ui-dist` folder. The UI answers with a content security policy that loads scripts and fonts only from its own origin, and it refuses to be framed.

Set `DRIVE_PUBLIC_URL` to the origin that serves the UI. A download link on another origin is refused.

### Mount the UI in your app

`agentic-drive/ui` renders the same UI inside your own page. It needs no framework in your app. You give it an element, the address of a drive server, and a function that returns the bearer token. `mount` returns a handle.

```ts
import "agentic-design/styles.css";   // tokens, fonts, and base styles for body, headings, and links
import "agentic-drive/ui.css";        // the drive styles
import { mount } from "agentic-drive/ui";

const drive = mount(document.getElementById("drive")!, {
  baseUrl: "https://drive.example.com",
  getToken: () => session.token,      // runs before every request, so it can refresh
});

drive.update({ baseUrl, getToken });  // use another server or callback
drive.unmount();                      // remove the UI
```

`getToken` returns 1 to 512 letters, digits, `-` or `_`, or `undefined` to send no `authorization` header. A bad `baseUrl` or a `getToken` that is not a function makes `mount` throw a `TypeError`. The server still checks every request against the token. The embed shows files and trash with upload, rename, move, share, and the "Created by agent" label. It has no sign-in form, because your app owns sign-in. It does not change the page address, and it has no theme switch. `agentic-design/styles.css` sets base styles for the whole page, and it follows the dark mode of the system unless your page sets `data-theme`. Add `agentic-design` to your own dependencies, because your page imports its files. The Worker sends no CORS headers, so the server must be on the origin of your page. Set `baseUrl` to the same address as `DRIVE_PUBLIC_URL`, or the UI refuses its download links. `unmount` and `update` abort the requests that run and stop an upload that has more files to send. The UI keeps the list or grid choice in `localStorage` under `agentic-drive-view`, and it has its own heading for each view. `DriveBrowser` is the same UI as a React component. Wrap it in `TooltipProvider` and `ToastProvider` from `agentic-design/react`. `react` and `react-dom` (version 19 or later) are optional peer dependencies. Install them in your project when you use `agentic-drive/ui`. The web UI that the Worker serves uses the same views.

### Serve the UI from the package

The npm package ships the built UI in `ui-dist`. The package does not ship a `wrangler.jsonc`, so a project that deploys its own Worker adds the assets block to its config. Its Worker re-exports the package Worker. In a workspace, the package can sit in the root `node_modules`. Then point `assets.directory` at that folder, such as `../../node_modules/agentic-drive/ui-dist`:

```js
// src/worker.js
export { default } from "agentic-drive/worker";
```

```jsonc
// wrangler.jsonc: the Worker reads the bindings DB (D1) and FILES (R2). Name yours the same.
// Create the bucket with `wrangler r2 bucket create agentic-drive-files --jurisdiction eu`.
// Create the database with `wrangler d1 create agentic-drive --location weur`, then put its id below.
{
  "name": "agentic-drive",
  "main": "src/worker.js",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [{ "binding": "DB", "database_name": "agentic-drive", "database_id": "<your id>" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "agentic-drive-files", "jurisdiction": "eu" }],
  // In a workspace, point this at the root node_modules instead.
  "assets": { "directory": "./node_modules/agentic-drive/ui-dist", "not_found_handling": "single-page-application", "run_worker_first": ["/api/*", "/health"] }
}
```

Set `DRIVE_URL_SECRET` and `DRIVE_PUBLIC_URL` with `npx wrangler secret put`. `DRIVE_URL_SECRET` needs 32 bytes or more. `DRIVE_PUBLIC_URL` is the origin of this Worker. The Worker declares region `eu` unless `DRIVE_REGION` says otherwise, so keep the EU jurisdiction and location above. Sign-in uses agentic-identity credentials in the same D1 database. Create a token there first, or every bearer API request gets 401. In the D1 database:

1. Create the table, unless a request has already run: `wrangler d1 execute agentic-drive --remote --command "CREATE TABLE IF NOT EXISTS store_docs (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (collection, id)) WITHOUT ROWID"`.
2. Insert a row into `store_docs` with `collection` `principals` and `id` `me`. Its body is `{ "id": "me", "kind": "human", "scopes": ["drive:admin"] }`.
3. Make the token with `openssl rand -hex 32`. A token may use only letters, digits, `_`, and `-`, up to 512 characters. Insert a row into `store_docs` with `collection` `credentials`. Its `id` is the lowercase hex SHA-256 of the token, which `printf %s "$TOKEN" | sha256sum` prints. Its body is `{ "principalId": "me", "kind": "api_key" }`.

The [seed script](https://github.com/pooriaarab/agentic-drive/blob/main/e2e/serve.mjs) shows these rows. Its tokens are for tests only. Never use them in a deployment. Without both secrets, the API answers 503. With this config, `/` serves the UI, and `/health` and `/api/v1/drive/*` answer from the Worker.

The UI does not make snapshot links yet. The address of a share link shows once, when you create it.

### Inject a store, blobs, and sign-in

A host that has its own Worker can serve the drive routes from it. `createApp` from `agentic-drive/worker` takes the parts to use. Each part is optional. A part may be a function of the Worker env, which runs on each request.

```ts
import { createApp } from "agentic-drive/worker";

const app = createApp({
  store: (env) => myStore(env),   // a Store of agentic-identity
  blobs: (env) => myBlobs(env),   // a Blobs of agentic-identity
  // Return a Ctx for the caller, or null for a 401.
  auth: async (request, store, env) => {
    const principal = await mySignIn(request, env);
    return principal && { owner: principal.chain[0].id, actor: { id: principal.principalId, kind: principal.kind }, principal };
  },
});
export default { fetch: app.fetch };
```

- With `store`, the Worker reads no `DB` binding. It does not create the table either, so the host owns the schema.
- With `blobs`, the Worker reads no `FILES` binding and needs no `DRIVE_PUBLIC_URL`. The blobs must sign download URLs that point to `/api/v1/drive/blob` on this Worker. That route checks the signature with `DRIVE_URL_SECRET` before it reads the store or the blobs, so set that secret.
- With `auth`, the Worker does not read bearer tokens from the store. The callback decides who the caller is. Return a whole `Ctx`: a `principal`, and an `owner` and `actor` that match it. Any other value gets 401. Make sure `principal.chain` and `principal.scopes` are real, because the drive checks them. A callback that reads a session cookie must check the request origin itself. Every write route is open to a cross-site form until it does.
- With no options, `createApp()` works as before: D1, R2, and bearer tokens from the store. `export { default } from "agentic-drive/worker"` is the same.

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
- `erasePerson()` erases a person for good, and only the person in person can call it (the CLI `delete-all` and `DELETE /account` call it). It deletes their drive with all its shares, the shares they hold, and the invites they or their agents sent, on drive items only: the grants of other apps stay for those apps and for identity. What they or their agents made in other drives stays, because it belongs to those drives: the id becomes `erased`, and the kind stays, so machine-made work keeps its label. Agents are found through the `principals` collection, as identity finds them: an agent with its own identity names the person as `ownerId`, and a delegated agent names its parent. An agent with its own identity belongs to the person, and so does its drive: erase deletes it, and the export lists its items (no bytes). A person with more than 1000 agents cannot be erased here: the call fails and deletes nothing more. The audit entries of the erased items go with them, through identity `deleteResource`. The entries about what the person did in other drives stay: they hold ids and kinds only. A failed call can run again. `deleteAll()` is the drive part alone.
- A `can()` hook decides who may read, write, or delete. Without `sharing`, the default allows the owner only.

## Limits

- Erase does not delete what identity keeps about the person: their principal, credentials, and sign-in record. Identity erases those. An invite that names only an email, sent by someone else, stays until it expires.
- Items made before drive kept `createdById` and `updatedById` have no such fields, so an export or an erase cannot find them. Run `backfillAuthorIds(store, { maxPages: 1 })` on a store of that age, once the old Worker has stopped writing. Each call runs `maxPages` pages of 10 items, and returns a `nextCursor` while items remain. Pass the cursor to the next call until none is returned. Without `maxPages`, one call runs every page, which can exceed a Worker's query cap on a large store.
- There are no retention settings yet, and no per-workspace export. An export covers one person.
- `registerDocument` makes one item per document in a drive. Two calls at the same moment can make two.

- Drive reads the `store_docs` table in D1 and `store.jsonl` in the CLI folder. It does not read older layouts. There is no import and no claim backfill.
- Uploads buffer the stream in memory up to the cap. The default cap is 25 MiB (`DEFAULT_MAX_BYTES`).
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
