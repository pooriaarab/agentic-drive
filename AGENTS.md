# agentic-drive agent guide

Store, sort, and share files and folders.

## Mental model

A drive holds folders and items. An item is a file, or a typed reference to a
document in another app. Each item belongs to one owner.

## Faces

- SDK: `import { createDrive } from "agentic-drive"`.
- CLI: `npx agentic-drive <command>`. Every command prints JSON.
- HTTP: `/api/v1/drive/*` on the Worker. Send `Authorization: Bearer <token>`.
- MCP: `npx agentic-drive mcp`. Tools: drive_ls, drive_stat, drive_mkdir, drive_upload,
  drive_download, drive_mv, drive_rm, drive_trash, drive_restore, drive_purge,
  drive_search, drive_export, drive_home, drive_register_document, drive_forget_document, drive_shares, drive_share, drive_unshare,
  drive_invite, drive_accept_invite, drive_create_link, drive_revoke_link, drive_delete_account.

## Rules

- A locator with a `/` is a path: `/x` from the root, or `<folder id>/x` from a folder. Any other locator is an id.
- Trash first. Purge only items that are in the trash.
- Report a `DriveError` as an error. Read its `code`.
- Run the CLI with an agent key in `AGENTIC_DRIVE_TOKEN`, so items show a machine made them. Exit code 3 means no valid key.
- Do not retry a `FORBIDDEN` error with other input. `NOT_FOUND` can mean you have no role.
- Name a shared item by id, or start a path at a folder id: `<id>/a.txt`.

Keywords: drive,files,folders,storage,upload,sharing,agents,mcp,cli,r2.
