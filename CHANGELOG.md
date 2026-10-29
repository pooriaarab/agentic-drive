# Changelog

## 0.2.0

Read the breaking changes before you upgrade. The migration steps follow them.

### Breaking changes

- **Sign-in uses agentic-identity.** The Worker no longer reads `DRIVE_API_TOKENS`. A bearer token is now a credential in the identity store. It names a principal, and the whole delegation chain must be live. Tokens in `DRIVE_API_TOKENS` stop working when you deploy this release.
- **The owner of a drive is the root of the principal's chain.** Before, the owner was the `owner` string of the token. Now a person's drive has the id of that person's principal.
- **Items from before sharing need a backfill.** Sharing is on in the Worker. Each item needs a `resources` doc, and items from 0.1.0 do not have one. Until you run `backfillResources`, their owner gets `NOT_FOUND`. See the migration steps.
- **Folders nest 15 deep, not 256, in a drive with sharing on.** The Worker turns sharing on. Sharing checks at most 16 resources on a path, the drive root included. A deeper item, move, or restore fails with `TOO_DEEP`. A local drive without sharing keeps 256. An item already deeper than 15 folders cannot be reached with sharing. Move it up in 0.1.0 before you upgrade.
- **Paths start in your own drive.** A path without an id resolves in the caller's own drive. A folder shared with you is reached by its id, as `<folder id>/a.txt`.
- **Big folders may not move.** A move or restore that must count the height of a folder with about 200 or more subfolders fails with `TOO_MANY_ITEMS`.
- **`authenticate` has a new signature.** It was `authenticate(request, env)`. It is now `authenticate(request, store, now?)`, and it returns a promise. The `Ctx` it returns has a `principal` field.
- **Agent tokens follow their grant scopes.** An agent used to act with the full rights of its owner in that drive. Now each action needs a scope in the agent's grant. An agent without the scope gets `FORBIDDEN`.
- **`DELETE /account` and `delete-all` erase the person.** Before, they deleted the drive. Now they call `erasePerson`. That also deletes the drives of the person's agents that have their own identity, the shares they hold, and the invites they sent. What they made in other people's drives stays. Those items keep their kind, and the id of the person on them becomes `erased`. The result is `{ removed, grants, invites, anonymized }`. Before, it was `{ removed }`.
- **The export manifest is version 2.** Version 2 adds `subject`, `partial`, `authored`, `agents`, `shares`, and `audit`. The item entries do not change. An agent gets `partial: true` and none of the person-level parts. A reader that accepts only version 1 must accept version 2.
- **Items carry `createdById` and `updatedById`.** Erase and export use these top-level fields to find a person's work. Items written before 0.2.0 do not have them. Code that builds a `Node` value must set both fields.
- **New error codes.** `CROSS_DRIVE`, `INVALID_SHARE`, and `TOO_MANY_ITEMS` are new. Code that handles every `ErrorCode` in a `Record` or a `switch` must handle them.
- **agentic-identity 0.3.0.** `listAudit` is paged. It returns `{ entries, nextCursor }`, newest first, 50 entries a page by default and 200 at most. It used to return an array. Drive does not expose `listAudit`. Code that calls it directly must read `entries`, and must pass `nextCursor` as `cursor` to read on.

### Migration

Read the known limits before you move a live deployment. Run the steps in this order. The old Worker keeps writing until step 3, so the backfill in step 4 must come after the deploy.

1. Install the new versions: `npm install agentic-drive@0.2.0 agentic-identity@^0.3.0`.
2. Write the principals, with the old ids. The owner of a drive is the principal id, and the old data keeps the old ids. Old tokens had no scopes. Give `drive:admin` to keep the old rights, or less to narrow them. The 0.1.0 data does not say what kind an owner is. Use `human` for a person. Use `agent` only for a machine that acts with no person. A wrong kind breaks the chains under that owner.
   - An owner of kind `human` is a root `human`. Its agents are `agent_of_human`, with `parentId` set to the owner. Its `user_token` actors are `user_token`, with `parentId` set to the owner. An `agent_of_agent` sits under one of those. 0.1.0 recorded no parent ids, so choose one, and keep the chain to 5 links (`MAX_CHAIN_DEPTH`).
   - An owner of kind `agent` is a root `agent`. Its actors are `agent_of_agent`, with `parentId` set to the owner. The same 5-link limit applies.
   - A human actor who is not the owner keeps its old actor id, as a root `human`. Share the drive with it, with the role `owner`, to keep its old rights. The role `editor` cannot purge or share.

   Write each one through the `Store` port:

   ```js
   import { createD1Store } from "agentic-identity/cloudflare";
   import { parseRegion } from "agentic-identity";

   export async function writePrincipal(env, principal) {
     const store = createD1Store(env.DB, { region: parseRegion(env.DRIVE_REGION ?? "eu") });
     await store.put("principals", principal.id, principal);
   }

   await writePrincipal(env, { id: "u1", kind: "human", scopes: ["drive:admin"] });
   await writePrincipal(env, { id: "bot", kind: "agent_of_human", parentId: "u1", scopes: ["drive:admin"] });
   ```

3. Deploy the 0.2.0 Worker. From this point, nobody can sign in until step 5.
4. Run the backfills once the old Worker has stopped writing. `backfillAuthorIds` fills in the author fields. `backfillResources` writes the missing `resources` docs, without which the 0.1.0 items are not reachable for their owners. Each call runs one page of 10 items and returns a `nextCursor` while items remain. Call the step again with that cursor until a call returns no cursor. On Cloudflare, deploy a one-off Worker that binds the same database. Protect it with a secret, and delete it after you run it:

   ```js
   import { createD1Store } from "agentic-identity/cloudflare";
   import { parseRegion } from "agentic-identity";
   import { backfillAuthorIds, backfillResources } from "agentic-drive/worker";

   // Compares two strings in a time that does not depend on where they differ.
   function same(a, b) {
     const x = new TextEncoder().encode(a);
     const y = new TextEncoder().encode(b);
     let diff = x.length ^ y.length;
     for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
     return diff === 0;
   }

   export default {
     async fetch(request, env) {
       const sent = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
       if (!env.BACKFILL_TOKEN || !same(sent, env.BACKFILL_TOKEN)) return new Response("forbidden", { status: 403 });
       const url = new URL(request.url);
       const steps = { authors: backfillAuthorIds, resources: backfillResources };
       const step = url.searchParams.get("step");
       if (!Object.hasOwn(steps, step)) return new Response("unknown step", { status: 400 });
       const store = createD1Store(env.DB, { region: parseRegion(env.DRIVE_REGION ?? "eu") });
       return Response.json(await steps[step](store, { cursor: url.searchParams.get("cursor") ?? undefined, maxPages: 1 }));
     },
   };
   ```

   Run `?step=authors`, then `?step=resources`. Pass each `nextCursor` as `cursor`. A second run of either step changes nothing. If a call fails, run it again with the last cursor that worked. A damaged item stops a step. Fix or delete that item, then run it again.
5. Issue a bearer token for each person with `issueCredential(store, { principalId, kind: "api_key", label })`, and give it to the person. A token is shown only once. Then make one call as each person, for example `GET /api/v1/drive/items?path=/`. That call creates the drive's root, which the items inherit their access from. Until the person makes it, an agent that calls first gets `NOT_FOUND`.
6. Issue the tokens for the agents and the other actors, and give them out.
7. Remove the old secret: `npx wrangler secret delete DRIVE_API_TOKENS`.
8. If your code calls `authenticate`, await it and pass the store: `await authenticate(request, store)`.
9. Tell your users that `DELETE /account?confirm=yes` and `agentic-drive delete-all --yes` now erase their agents and their shares too. Neither can be undone.

Known limits of this release:

- **OIDC sign-in gets a new id.** agentic-identity gives an OIDC person the id `u_` plus a hash of the issuer and the subject. That id is not the old owner string. A person who signs in through OIDC does not see a drive made under the old owner string. Use bearer tokens for those drives until a re-key step ships.
- **There is no re-key step.** This release does not move items from one owner id to another. Keep the old ids as principal ids, as step 2 does.
- **Old items keep their old kind labels.** An old actor of kind `agent` may now be `agent_of_human`. New items carry the new kind, so a search by `--created-by-kind` sees the old and the new work under different kinds.

### Added

- App documents. An app puts a document in the drive with `registerDocument`. `forgetDocument` moves every reference to it to the trash. `home` lists files and app documents together. `search` takes an `app` filter.
- Sharing with roles (`viewer`, `commenter`, `editor`). Invites by email or handle, share links with an optional expiry, and a signed-in-only option.
- `exportPerson`, `erasePerson`, `backfillAuthorIds`, and `backfillResources`. The two backfills are exported from `agentic-drive` and `agentic-drive/worker`.
- HTTP: `GET /home`, `POST /documents`, `DELETE /documents`, the `/shares`, `/invites`, `/links`, and `/shared` routes, and `DELETE /account`.
- CLI: `home`, `register`, and `forget`.
- MCP: `drive_home`, `drive_register_document`, and `drive_forget_document`.

### Changed

- CLI `delete-all` erases the person, not only the drive. See the breaking changes.
- The package builds before it is packed (`prepack`). The tarball holds the built files, the docs, and this changelog.
- The publish workflow runs the build, the typecheck, and the tests on Node 22 with no `--if-present`, as CI does. Both workflows set `WRANGLER_SEND_METRICS` to `false`.

## 0.1.0

- First release. A drive of files and folders, with uploads to R2, search, export, hard delete, the CLI, the MCP server, and the Worker API.
