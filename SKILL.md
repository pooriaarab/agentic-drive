---
name: agentic-drive
description: Store, sort, and share files and folders. Keywords: drive,files,folders,storage,upload,sharing,agents,mcp,cli,r2.
---

# agentic-drive

Store, sort, and share files and folders.

## Use the SDK

```js
import { createDrive, createMemoryStore, createMemoryBlobs } from "agentic-drive";

const drive = createDrive({ store: createMemoryStore(), blobs: createMemoryBlobs() });
const me = { owner: "u1", actor: { id: "u1", kind: "human" } };
await drive.mkdir(me, "/notes");
```

## Rules

- A path starts with `/`. Any other locator is an id.
- Trash before purge.
- Report a `DriveError` as a failure.
