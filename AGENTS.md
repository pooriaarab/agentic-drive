# agentic-drive agent guide

Store, sort, and share files and folders.

## Mental model

A drive holds folders and items. An item is a file, or a typed reference to a
document in another app. Each item belongs to one owner.

## Faces

- SDK: `import { createDrive } from "agentic-drive"`.
- CLI and MCP: not built yet.

## Rules

- A string that starts with `/` is a path. Any other string is an id.
- Trash first. Purge only items that are in the trash.
- Report a `DriveError` as an error. Read its `code`.
- Do not retry a `FORBIDDEN` error with other input.

Keywords: drive,files,folders,storage,upload,sharing,agents,mcp,cli,r2.
