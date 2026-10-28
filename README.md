# agentic-drive

[![npm version](https://img.shields.io/npm/v/agentic-drive)](https://www.npmjs.com/package/agentic-drive)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-drive) · [Source](https://github.com/pooriaarab/agentic-drive) · [Support](https://github.com/pooriaarab/agentic-drive/issues)

Store, sort, and share files and folders.

> Status: scaffold. This repository holds the starter code only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- Folders, files, and uploads, with search.
- Roles that pass down from a folder to its files.
- Share by invite or link, with expiry.
- Agent tools: list, read, upload, move, and share.
- File storage behind a port: Cloudflare R2 now, other stores later.
- Trash and restore.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-drive"`.
- **CLI**: `npx agentic-drive --help`.
- **MCP server**: `npx agentic-drive mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
