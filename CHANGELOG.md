# Changelog

## 0.2.0

Read the breaking changes before you upgrade. The migration steps follow them.

### Breaking changes

- **Sign-in uses agentic-identity.** The Worker no longer reads `DRIVE_API_TOKENS`. A bearer token is now a credential in the identity store. It names a principal, and the whole delegation chain must be live. Tokens in `DRIVE_API_TOKENS` stop working.
- **`authenticate` has a new signature.** It was `authenticate(request, env)`. It is now `authenticate(request, store, now?)`, and it returns a promise. The `Ctx` it returns has a `principal` field.
- **`DELETE /account` and `delete-all` erase the person.** Before, they deleted the drive. Now they call `erasePerson`. That also deletes the drives of the person's agents that have their own identity, the shares they hold, and the invites they sent. What they made in other people's drives stays. Those items keep their kind, and the id of the person on them becomes `erased`. The result is `{ removed, grants, invites, anonymized }`. Before, it was `{ removed }`.
- **The export manifest is version 2.** Version 2 adds `subject`, `partial`, `authored`, `agents`, `shares`, and `audit`. The item entries do not change. An agent gets `partial: true` and none of the person-level parts. A reader that accepts only version 1 must accept version 2.
- **Items carry `createdById` and `updatedById`.** Erase and export use these top-level fields to find a person's work. Items written before 0.2.0 do not have them. See the migration steps.
- **agentic-identity 0.3.0.** `listAudit` returns a page: `{ entries, nextCursor }`. It used to return an array. Drive does not expose `listAudit`, but code that calls it directly must read `entries`.

### Migration

1. Install the new versions: `npm install agentic-drive@0.2.0 agentic-identity@^0.3.0`.
2. Run `backfillAuthorIds(store)` once on the store your deployment uses. It returns `{ fixed }`. It changes only the two author fields, and a second run changes nothing. Run it before you erase or export a person's work in other drives. Without it, the old items are not found.
3. Replace each `DRIVE_API_TOKENS` entry with a principal and a bearer credential in agentic-identity. Then remove the secret: `npx wrangler secret delete DRIVE_API_TOKENS`.
4. If your code calls `authenticate`, await it and pass the store: `await authenticate(request, store)`.
5. Tell your users that `DELETE /account?confirm=yes` and `agentic-drive delete-all --yes` now erase their agents and their shares too. Both cannot be undone.

### Added

- App documents. An app puts a document in the drive with `registerDocument`, and removes it with `forgetDocument`. `home` lists files and app documents together. `search` takes an `app` filter.
- Sharing with roles (`viewer`, `commenter`, `editor`). Invites by email or handle, share links with an optional expiry, and a signed-in-only option.
- `exportPerson`, `erasePerson`, and `backfillAuthorIds`.
- HTTP: `GET /home`, `POST /documents`, `DELETE /documents`, the `/shares`, `/invites`, `/links`, and `/shared` routes, and `DELETE /account`.
- CLI: `home`, `register`, and `forget`.
- MCP: `drive_home`, `drive_register_document`, and `drive_forget_document`.

### Changed

- CLI `delete-all` erases the person, not only the drive. See the breaking changes.
- The package builds before it is packed (`prepack`). A published tarball holds the built files only.
- CI and the publish workflow run the build, the typecheck, and the tests on Node 22. They no longer skip a step that is missing.

## 0.1.0

- First release. A drive of files and folders, with uploads to R2, search, export, hard delete, the CLI, the MCP server, and the Worker API.
