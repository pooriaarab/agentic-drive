// The sharing and person suites, run again on the shared file store. That store runs its calls one at a
// time and demands that a transaction reads before it writes, so a call from inside a transaction to the
// store outside it hangs. The memory store lets such a call run, so only this suite shows it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore } from "agentic-identity/file";
import { backend } from "./test-backend.js";

backend.store = () => createFileStore({ path: join(mkdtempSync(join(tmpdir(), "drive-shared-")), "db") });
await import("./sharing.test.js");
await import("./person.test.js");

await import("./hostops.test.js");
