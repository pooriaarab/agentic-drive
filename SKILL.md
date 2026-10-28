---
name: agentic-drive
description: Store, sort, and share files and folders. Keywords: drive,files,folders,storage,upload,sharing,agents,mcp,cli,r2.
---

# agentic-drive

Store, sort, and share files and folders.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-drive";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-drive summary --text "some text"
agentic-drive dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-drive mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
