import type { Store } from "agentic-identity";
import { createMemoryStore } from "agentic-identity";

/** The store the sharing and person suites open. `file-store.test.ts` swaps it, so the same suites run on the shared file store. */
export const backend: { store: () => Store } = { store: () => createMemoryStore() };
