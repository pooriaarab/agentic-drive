---
name: agentic-drive
description: Store, sort, and share files and folders. Keywords: drive,files,folders,storage,upload,sharing,agents,mcp,cli,r2.
---

# agentic-drive

Store, sort, and share files and folders.

## Use the SDK

```js
import { createDrive } from "agentic-drive";
import { createMemoryStore, createMemoryBlobs } from "agentic-identity";

const drive = createDrive({ store: createMemoryStore(), blobs: createMemoryBlobs() });
const me = { owner: "u1", actor: { id: "u1", kind: "human" } };
await drive.mkdir(me, "/notes");
```

To call a deployed Worker, use the remote client. It runs in browsers, Workers, and Node 22:

```js
import { createClient } from "agentic-drive/client";

const remote = createClient({ baseUrl: "https://drive.example.com", token });
await remote.mkdir("/notes");
```

A failed call throws `DriveApiError`. Read its `code` and `status`.

## Rules

- A locator with a `/` is a path: `/x` from the root, or `<folder id>/x` from a folder. Any other locator is an id.
- Trash before purge.
- Report a `DriveError` as a failure.
