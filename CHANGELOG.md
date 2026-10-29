# Changelog

## 0.2.0

Read the breaking changes before you upgrade. The migration steps follow them.

### Breaking changes

- **Sign-in uses agentic-identity.** The Worker no longer reads `DRIVE_API_TOKENS`. A bearer token is now a credential in the identity store. It names a principal, and the whole delegation chain must be live. Tokens in `DRIVE_API_TOKENS` stop working.
- **The owner of a drive is the root of the principal's chain.** Before, the owner was the `owner` string of the token. Now a person's drive has the id of that person's principal.
- **`authenticate` has a new signature.** It was `authenticate(request, env)`. It is now `authenticate(request, store, now?)`, and it returns a promise. The `Ctx` it returns has a `principal` field.
- **Agent tokens follow their grant scopes.** An agent used to act with the full rights of its owner in that drive. Now each action needs a scope in the agent's grant. An agent without the scope gets `FORBIDDEN`.
- **`DELETE /account` and `delete-all` erase the person.** Before, they deleted the drive. Now they call `erasePerson`. That also deletes the drives of the person's agents that have their own identity, the shares they hold, and the invites they sent. What they made in other people's drives stays. Those items keep their kind, and the id of the person on them becomes `erased`. The result is `{ removed, grants, invites, anonymized }`. Before, it was `{ removed }`.
- **The export manifest is version 2.** Version 2 adds `subject`, `partial`, `authored`, `agents`, `shares`, and `audit`. The item entries do not change. An agent gets `partial: true` and none of the person-level parts. A reader that accepts only version 1 must accept version 2.
- **Items carry `createdById` and `updatedById`.** Erase and export use these top-level fields to find a person's work. Items written before 0.2.0 do not have them. Code that builds a `Node` value must set both fields.
- **Moves into another person's drive fail.** A move to another owner's drive fails with `CROSS_DRIVE`.
- **New error codes.** `CROSS_DRIVE`, `INVALID_SHARE`, and `TOO_MANY_ITEMS` are new. Code that handles every `ErrorCode` in a `Record` or a `switch` must handle them.
- **agentic-identity 0.3.0.** `listAudit` is paged. It returns `{ entries, nextCursor }`, newest first, 50 entries a page by default and 200 at most. It used to return an array. Drive does not expose `listAudit`. Code that calls it directly must read `entries`, and must pass `nextCursor` as `cursor` to read on.

### Migration

1. Install the new versions: `npm install agentic-drive@0.2.0 agentic-identity@^0.3.0`.
2. Sign-in. For each person, create a principal in agentic-identity with the same id as the old `owner` value. Otherwise the person opens an empty drive. Create each agent as a delegated principal of its person. Give each one a bearer credential. An old token whose actor is a human who differs from the owner has no equal here. Share the drive with that actor's principal instead, with `POST /shares`. Then remove the old secret: `npx wrangler secret delete DRIVE_API_TOKENS`.
3. Run `backfillAuthorIds(store)` once on each store that holds items from before 0.2.0. It returns `{ fixed }`. It changes only the two author fields, and a second run changes nothing. Until you run it, erase and export do not find those items in other drives, and erase leaves the person's id on them. On Cloudflare, the store is the D1 database. Deploy a one-off Worker that binds the same database, call it once, then delete it. Use the region of your deployment (`DRIVE_REGION`, default `eu`):

   ```js
   import { createD1Store } from "agentic-identity/cloudflare";
   import { backfillAuthorIds } from "agentic-drive/worker";

   export default {
     async fetch(request, env) {
       return Response.json(await backfillAuthorIds(createD1Store(env.DB, { region: "eu" })));
     },
   };
   ```

4. If your code calls `authenticate`, await it and pass the store: `await authenticate(request, store)`.
5. Tell your users that `DELETE /account?confirm=yes` and `agentic-drive delete-all --yes` now erase their agents and their shares too. Neither can be undone.

### Added

- App documents. An app puts a document in the drive with `registerDocument`. `forgetDocument` moves every reference to it to the trash. `home` lists files and app documents together. `search` takes an `app` filter.
- Sharing with roles (`viewer`, `commenter`, `editor`). Invites by email or handle, share links with an optional expiry, and a signed-in-only option.
- `exportPerson`, `erasePerson`, and `backfillAuthorIds`. `backfillAuthorIds` is also exported from `agentic-drive/worker`.
- HTTP: `GET /home`, `POST /documents`, `DELETE /documents`, the `/shares`, `/invites`, `/links`, and `/shared` routes, and `DELETE /account`.
- CLI: `home`, `register`, and `forget`.
- MCP: `drive_home`, `drive_register_document`, and `drive_forget_document`.

### Changed

- CLI `delete-all` erases the person, not only the drive. See the breaking changes.
- The package builds before it is packed (`prepack`). The tarball holds the built files, the docs, and this changelog.
- CI and the publish workflow run the build, the typecheck, and the tests on Node 22. They no longer skip a step that is missing.

## 0.1.0

- First release. A drive of files and folders, with uploads to R2, search, export, hard delete, the CLI, the MCP server, and the Worker API.
