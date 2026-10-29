# Changelog

## 0.7.0

Read the breaking changes before you upgrade.

### Breaking changes

- **The local drive has sharing on.** `openLocal` now passes `createSharing(store)`, as the Worker does. Items made before 0.7.0 have no `resources` docs. The CLI and the `mcp` command add them once, on the first drive command that has a valid key. The `principal` and `key` commands do not do it. A project that calls `openLocal` itself must run `backfillResources(store)`, exported from the package root, once on its existing data folder. If an item has no owner or parent, the backfill stops, and drive commands fail until you fix that item.

### Added

- **Sharing in the CLI.** New commands: `shares`, `share`, `unshare`, `invite`, `accept-invite`, `link-create`, and `link-revoke`. They act like the HTTP routes and show in `--help`.
- **Sharing in the MCP server.** New tools: `drive_shares`, `drive_share`, `drive_unshare`, `drive_invite`, `drive_accept_invite`, `drive_create_link`, and `drive_revoke_link`.
- **`drive_delete_account` in the MCP server.** It erases the caller like `DELETE /account` and `delete-all`. It needs `confirm: "yes"`.

## 0.6.1

### Changed

- **Bearer tokens are checked by the agentic-identity HTTP helper.** The Worker and the local key check now call `requirePrincipal` from `agentic-identity/http` (agentic-identity 0.6). The package no longer has its own copy of the bearer-token check in `src/auth.ts` and `src/local.ts`. A request without an `authorization` header still gets no caller, so a session cookie does not sign in. A bad key still gives 401, and `resolveToken` still throws `AuthError` with the code `UNAUTHENTICATED`.
- **The dependency is agentic-identity 0.6.** The package now needs `agentic-identity` `^0.6.0`.

## 0.6.0

### Added

- **`createApp` takes an injected store, blobs, and auth.** `createApp({ store, blobs, auth })` from `agentic-drive/worker` lets a host serve the drive routes with its own `Store`, `Blobs`, and sign-in callback. Each part may be a function of the Worker env. With no options, the Worker works as before. A Worker with no `DB` or `FILES` binding and no injected store or blobs now answers 503 `NOT_CONFIGURED`. The package also exports the `AppOptions` type.
- **Mountable UI at `agentic-drive/ui`.** `mount(element, { baseUrl, getToken })` renders the drive UI in any page and returns `{ update, unmount }`. `getToken` runs before each request. The styles are in `agentic-drive/ui.css`. The embed keeps its folder in memory, so it does not change the page address. `react` and `react-dom` 19 are optional peer dependencies, and `agentic-design` is now a dependency.

## 0.5.0

Read the breaking changes before you upgrade or deploy.

### Breaking changes

- **Deploy the Worker and the client together.** Each item in the HTTP, CLI, and MCP output has a `machineMade` field next to `createdBy.kind`. The client now rejects an item with no `machineMade`. A client of 0.5.0 that talks to a Worker of 0.4.0 fails every call that returns items, such as list, stat, and search. Also, `Item` and `PathItem` in the client types now require `machineMade: boolean`. A project that builds those objects itself, such as test fixtures or mocks of the client, must add the field.

### Added

- **Machine-made label from creation on.** The web UI shows "Created by agent" on every item that an agent made, not only after a person edits it.

## 0.4.0

Read the breaking changes before you upgrade or deploy.

### Breaking changes

- **The CLI acts as a real principal.** The `--owner`, `--actor`, and `--actor-kind` flags and the `AGENTIC_DRIVE_OWNER`, `_ACTOR`, and `_KIND` variables are gone. Pass an API key with `--token` or `AGENTIC_DRIVE_TOKEN`. agentic-identity resolves the key. With no key, or a revoked or unknown key, the CLI and `mcp` exit with code 3. The default owner `me` is gone.
- **`openLocal(dir)` takes a folder and returns `{ drive, store }`.** Use `resolveToken(store, token)` to get the `ctx`.
- **The Worker serves the web UI from `ui-dist`.** `wrangler.jsonc` names `ui-dist` as the assets folder. Run `npm run build:ui` before each `wrangler deploy`. Without the build, the deploy fails because `ui-dist` does not exist. A `ui-dist` left from an older build ships an old UI.
- **Paths other than `/api/*` and `/health` get the UI.** The assets answer every other path. An unknown GET path returns the UI page with status 200, not a 404 from the Worker. A client that expects a 404 for such a path must change.

### Added

- **`principal add`, `principal revoke`, `key issue`, and `key revoke`** make local principals and keys. `principal add` takes `--of <person>` for an agent and `--scope <s>`, which repeats. `key issue` takes `--label`. The package root also exports `addPrincipal`, `revokePrincipal`, `issueKey`, `revokeKey`, and `AuthError`.
- **A web UI.** The Worker serves it from `ui-dist` (`npm run build:ui`). It uses agentic-design and the typed client. It has a folder tree, breadcrumbs, a list and a grid, upload by button and by drop, new folder, rename, move, trash and restore, and a share dialog. An item that an agent made shows a "Created by agent" label while a person is its last editor. "Edited by" names the last editor, a person or an agent. A Playwright test with an axe WCAG 2.2 AA check covers each view in light and dark.
- **A content security policy.** The UI loads scripts and fonts only from its own origin. It allows inline styles. The UI refuses to be framed. It also sends `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- **Same-origin downloads.** The UI refuses a download link on another origin. Set `DRIVE_PUBLIC_URL` to the origin that serves the UI.
- **The UI ships in the package.** `npm pack` runs `build:ui` in `prepack`, and the tarball has `ui-dist`.

### Changed

- `npm run ci:local` and CI also build the UI and run `npm run test:e2e`. The E2E test needs Chromium.
- The package adds no runtime dependency. The UI build and test tools are dev dependencies.
- The MCP registry entry names `AGENTIC_DRIVE_TOKEN` as a required secret, and `AGENTIC_DRIVE_DIR` as optional.

### Migration

Local data from 0.3.0 belongs to the owner `me`, or to the id you passed to `--owner`. The data folder does not change. Without the key of that owner, the CLI shows an empty drive. Make the principal and a key, then use the key:

1. Run `npx agentic-drive principal add me`, with your old owner id if it was not `me`. Pass the same `--dir` or `AGENTIC_DRIVE_DIR` as before, if you set one.
2. Run `export AGENTIC_DRIVE_TOKEN=$(npx agentic-drive key issue me | jq -r .token)`.
3. Put the same key in each MCP client config as `AGENTIC_DRIVE_TOKEN`, and the same data folder as `AGENTIC_DRIVE_DIR`, if you set one.

## 0.3.0

Read the breaking changes before you upgrade. The migration steps follow them.

### Breaking changes

- **agentic-identity 0.4.0.** A grant has a kind and an id, and a person and an agent with the same id are two subjects. The range is now `^0.4.0`. Run identity's `migrateGrants` once on a store with grants from 0.3.0. See the migration steps.
- **`shareWith` and `unshare` take a subject.** The subject is `{ kind: "human" | "agent", id }`, not a bare id. A subject with no kind, or with another kind, fails with `INVALID_SHARE`. The HTTP routes take `subjectKind` next to `subjectId`: in the body of `POST /shares`, and in the query of `DELETE /shares`. `GET /shares` lists `subjectKind` on each grant.
- **Erase and export read grants by kind.** A person's erase and export touch the grants of that person and of their agents with their own identity. A grant of an agent with the same id as a person stays.

### Added

- **`agentic-drive/client`.** A typed client for the HTTP API: `createClient({ baseUrl, token, fetch?, retries? })`. It has one method for each bearer route and each shared route, a typed `DriveApiError` with the API `code` and the HTTP `status`, and `AbortSignal` support. It sends a write once. It uses only `fetch`.

### Changed

- A purge, `deleteAll`, and `erasePerson` erase each item and the drive root through identity's `deleteResource`. The grants, links, invites, and audit entries of the item go with it, so none survives the item. Before, the audit entries stayed. The shares go while the item is marked for erase, before its row goes, so a failed call leaves a marked item and the same call runs again. A caller who does not own the item, and an agent drive that `erasePerson` removes, get the same result from a sweep. A purge costs more calls for each item. Only the owner of the drive, in person, can finish a purge that failed after the shares were erased. An agent gets `NOT_FOUND` for that item.
- New exports `subjectKindOf` and `parseSubject`. `subjectKindOf` accepts the kind of the root of a chain, `human` or `agent`, and throws on any other kind, a delegated one too.
- An export lists `subjectKind` on each grant a person holds.

### Migration

Run the steps in this order. The old Worker keeps writing grants in the old format until step 3, so the migration in step 4 must come after the deploy.

1. Install the new versions: `npm install agentic-drive@0.3.0 agentic-identity@^0.4.0`.
2. Change every call of `shareWith` and `unshare` in your code to pass `{ kind, id }`. The build fails on a bare id, and a bare id in JavaScript fails with `INVALID_SHARE`.
3. Deploy the 0.3.0 Worker. **From now until step 4, every owner loses access to their own drive.** Owner grants from before 0.3.0 are in the old format too, and identity 0.4.0 does not honor them. Everybody gets `NOT_FOUND`, and `erasePerson` and the export skip those grants. Run step 4 right after the deploy, or plan a maintenance window.
4. Run `migrateGrants` in a one-off Worker set up as in the 0.2.0 steps. Add it to the `steps` of that Worker, for example `grants: (store) => migrateGrants(store)`, with `import { migrateGrants } from "agentic-identity"`. It rewrites grants that have no kind. If the call fails or runs out of time, call it again until `migrated` is 0. It skips what is done. Delete the one-off Worker after it.
5. Delete from the `grants` collection each doc id that `migrateGrants` lists in `unresolved`. Its subject is gone, and identity never honors it. The share list leaves such a grant out.
6. Change every HTTP client of `POST /shares` and `DELETE /shares` to send `subjectKind`. The new client does this.

## 0.2.0

Read the breaking changes before you upgrade. The migration steps follow them.

### Breaking changes

- **Sign-in uses agentic-identity.** The Worker no longer reads `DRIVE_API_TOKENS`. A bearer token is now a credential in the identity store. It names a principal, and the whole delegation chain must be live. Tokens in `DRIVE_API_TOKENS` stop working when you deploy this release.
- **The owner of a drive is the root of the principal's chain.** Before, the owner was the `owner` string of the token. Now a person's drive has the id of that person's principal.
- **Items from before sharing need a backfill.** Sharing is on in the Worker. Each item needs a `resources` doc, and items from 0.1.0 do not have one. Until you run `backfillResources`, their owner gets `NOT_FOUND`. See the migration steps.
- **Folders nest 15 deep, not 256, in a drive with sharing on.** The Worker turns sharing on. Sharing checks at most 16 resources on a path, the drive root included. A deeper item, move, or restore fails with `TOO_DEEP`. A local drive without sharing keeps 256. An item already deeper than 15 folders cannot be reached with sharing. Move it up in 0.1.0 before you upgrade.
- **A locator with a `/` is a path.** A path is `/x` from the root, or `<folder id>/x` from a folder. Before, only a leading `/` made a path. Ids that the drive makes never contain `/`. A path without an id starts in the caller's own drive.
- **Trash asks for `write`, not `delete`.** An editor can trash an item. A custom `can` hook that allowed trash only for `delete` must change.
- **Big folders may not move.** In a drive with sharing on, a move or restore that must count the height of a folder with about 200 or more subfolders fails with `TOO_MANY_ITEMS`.
- **Restore into another folder needs `write` on that folder.** Before, a restore checked only the item.
- **`authenticate` has a new signature.** It was `authenticate(request, env)`. It is now `authenticate(request, store, now?)`, and it returns a promise. The `Ctx` it returns has a `principal` field.
- **Agent tokens follow their grant scopes.** An agent used to act with the full rights of its owner in that drive. Now each action needs a scope in the agent's grant. An agent without the scope gets `FORBIDDEN`.
- **`DELETE /account` and `delete-all` erase the person.** Before, they deleted the drive. Now they call `erasePerson`. That also deletes the drives of the person's agents that have their own identity, the shares they hold, and the invites they sent. What they made in other people's drives stays. Those items keep their kind, and the id of the person on them becomes `erased`. The result is `{ removed, grants, invites, anonymized }`. Before, it was `{ removed }`.
- **The export manifest is version 2.** Version 2 adds `subject`, `partial`, `authored`, `agents`, `shares`, and `audit`. The item entries do not change. An agent gets `partial: true` and none of the person-level parts. A reader that accepts only version 1 must accept version 2.
- **Items carry `createdById` and `updatedById`.** Erase and export use these top-level fields to find a person's work. Items written before 0.2.0 do not have them. Code that builds a `Node` value must set both fields.
- **New error codes.** `CROSS_DRIVE`, `INVALID_SHARE`, and `TOO_MANY_ITEMS` are new. Export and erase also fail with `TOO_MANY_ITEMS` when a person has more than 1000 agents. Code that handles every `ErrorCode` in a `Record` or a `switch` must handle them.
- **agentic-identity 0.3.0.** `grant` refuses to lower the last owner of a resource, which fails with `INVALID_SHARE`. `listAudit` is paged. It returns `{ entries, nextCursor }`, newest first, 50 entries a page by default and 200 at most. It used to return an array. Drive does not expose `listAudit`. Code that calls it directly must read `entries`, and must pass `nextCursor` as `cursor` to read on.

### Migration

Read the known limits before you move a live deployment. Run the steps in this order. The old Worker keeps writing until step 4, so the backfills in step 5 must come after the deploy.

The steps 3, 5, 6, and 8 run code that needs the D1 database. Run it in one one-off Worker, and delete it after the last step. The Worker checks a secret on every call, so nobody else can call it. It binds the same database as the main Worker, with the same `DRIVE_REGION`, and it has `compatibility_flags: ["nodejs_compat"]`, as the main Worker has:

```js
import { createD1Store } from "agentic-identity/cloudflare";
import { issueCredential, parseRegion } from "agentic-identity";
import { backfillAuthorIds, backfillResources } from "agentic-drive/worker";

// Compares two strings in a time that does not depend on where they differ.
function same(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Each step takes one call. The body of a POST is JSON.
const steps = {
  // POST a principal document, such as { "id": "u1", "kind": "human", "scopes": ["drive:admin"] }.
  principal: (store, body) => store.put("principals", body.id, body),
  // Runs one page. Pass the `nextCursor` of the last call as `cursor`.
  authors: (store, body, cursor) => backfillAuthorIds(store, { cursor, maxPages: 1 }),
  resources: (store, body, cursor) => backfillResources(store, { cursor, maxPages: 1 }),
  // POST { "principalId": "u1", "label": "laptop" }. The token comes back once, so send it only to your terminal.
  token: async (store, body) => ({ token: await issueCredential(store, { principalId: body.principalId, kind: "api_key", label: body.label }) }),
};

export default {
  async fetch(request, env) {
    const sent = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!env.MIGRATE_TOKEN || !same(sent, env.MIGRATE_TOKEN)) return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    const step = url.searchParams.get("step");
    if (!Object.hasOwn(steps, step)) return new Response("unknown step", { status: 400 });
    const body = request.method === "POST" ? await request.json() : {};
    const store = createD1Store(env.DB, { region: parseRegion(env.DRIVE_REGION ?? "eu") });
    return Response.json((await steps[step](store, body, url.searchParams.get("cursor") ?? undefined)) ?? { ok: true });
  },
};
```

Set the secret with `wrangler secret put MIGRATE_TOKEN`. Send it as `authorization: Bearer <token>` with each call.

1. Check the ids. Every owner and actor id in `DRIVE_API_TOKENS` must match `^[A-Za-z0-9_-]{1,128}$`, the rule that agentic-identity 0.3.0 applies to share subjects. 0.1.0 allowed any text, such as an email address. A deployment with an id that fails this rule cannot move to 0.2.0 in this release, because there is no re-key step. Stay on 0.1.0 for it.
2. Install the new versions: `npm install agentic-drive@0.2.0 agentic-identity@^0.3.0`.
3. Write the principals, with the old ids. The owner of a drive is the principal id, and the old data keeps the old ids. Old tokens had no scopes. Give `drive:admin` to keep the old rights. The root principal of each owner must keep `drive:write` at least, because its first call creates the drive root. Narrow the agents, not the owner. The 0.1.0 data does not say what kind an owner is. Use `human` for a person. Use `agent` only for a machine that acts with no person. A wrong kind breaks the chains under that owner. POST each principal to `?step=principal`:
   - An owner of kind `human` is a root `human`. Its agents are `agent_of_human`, with `parentId` set to the owner. Its `user_token` actors are `user_token`, with `parentId` set to the owner. An `agent_of_agent` sits under an `agent_of_human`. 0.1.0 recorded no parent ids, so choose one, and keep the chain to 5 links (`MAX_CHAIN_DEPTH`).
   - An owner of kind `agent` is a root `agent`. Its actors are `agent_of_agent`, with `parentId` set to the owner. The same 5-link limit applies.
   - A human actor who is not the owner keeps its old actor id, as a root `human`. Step 7 shares the folders with it. It keeps no path access to the owner's drive. See the known limits.
4. Deploy the 0.2.0 Worker. From this point, nobody can sign in until step 6.
5. Run the backfills once the old Worker has stopped writing. Call `?step=authors`, then `?step=resources`, and pass each `nextCursor` as `cursor`. Stop when a call returns no `nextCursor`. A second run of either step changes nothing. If a call fails, run it again with the last cursor that worked. A damaged item stops a step. Fix or delete that item, then run it again.
6. Issue a bearer token for each owner: POST `{ "principalId": "u1", "label": "..." }` to `?step=token`. Give it to the owner. The token is shown only once. Then make one call as each owner, for example `GET /api/v1/drive/items?path=/`. That call creates the drive's root, which the items inherit their access from. Until a person makes it, an agent without `drive:write` that calls first gets `NOT_FOUND`.
7. Share with each human actor that is not the owner. As the owner, share the root `/` and each folder that the actor used. Use the role `owner`, which keeps its old rights. Before that, share each folder with the owner as `owner`, so that the last-owner rule still leaves an owner when the actor's grant changes later. Do this after step 6, because a share needs the item's `resources` doc and the drive root.
8. Issue the tokens for the agents and the other human actors: POST to `?step=token` for each, and give them out.
9. Remove the secrets: `npx wrangler secret delete DRIVE_API_TOKENS`, and delete the one-off Worker.
10. If your code calls `authenticate`, await it and pass the store: `await authenticate(request, store)`.
11. Tell your users that `DELETE /account?confirm=yes` and `agentic-drive delete-all --yes` now erase their agents and their shares too. Neither can be undone.

Known limits of this release:

- **OIDC sign-in gets a new id.** agentic-identity gives an OIDC person the id `u_` plus a hash of the issuer and the subject. That id is not the old owner string. A person who signs in through OIDC does not see a drive made under the old owner string. Use bearer tokens for those drives until a re-key step ships.
- **There is no re-key step.** This release does not move items from one owner id to another. Keep the old ids as principal ids, as step 3 does.
- **An id that fails the share rule blocks the upgrade.** See step 1.
- **Old items keep the kind they had in 0.1.0.** New items carry the kind of their new principal, which can differ, as step 3 shows. So a search by `--created-by-kind` sees the old and the new work under different kinds.
- **A human who is not the owner has no path access to the owner's drive.** Its paths resolve in its own drive. It reaches the owner's items by id, once they are shared with it.

### Added

- App documents. An app puts a document in the drive with `registerDocument`. `forgetDocument` moves every reference to it to the trash. `home` lists files and app documents together. `search` takes an `app` filter.
- Sharing with roles (`viewer`, `commenter`, `editor`, `owner`). Invites by email or handle, share links with an optional expiry, and a signed-in-only option.
- `exportPerson`, `erasePerson`, `backfillAuthorIds`, and `backfillResources`. The two backfills are exported from `agentic-drive` and `agentic-drive/worker`.
- HTTP: `GET /home`, `POST /documents`, `DELETE /documents`, and the `/shares`, `/invites`, `/links`, and `/shared` routes.
- CLI: `home`, `register`, and `forget`.
- MCP: `drive_home`, `drive_register_document`, and `drive_forget_document`.

### Changed

- CLI `delete-all` erases the person, not only the drive. See the breaking changes.
- The package builds before it is packed (`prepack`). The tarball holds the built files, the docs, and this changelog. The publish workflow passes `--ignore-scripts`, so it packs the `dist/` that its build step made. Keep that build step before publish.
- The publish workflow runs the build, the typecheck, and the tests on Node 22 with no `--if-present`, as CI does. Both workflows set `WRANGLER_SEND_METRICS` to `false`.

## 0.1.0

- First release. A drive of files and folders, with uploads to R2, search, export, hard delete, the CLI, the MCP server, and the Worker API.
