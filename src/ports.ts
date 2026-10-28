// Local copy of the Store and Blobs port shapes from agentic-identity.
// Swap this file for `import ... from "agentic-identity"` when that package ships.
export type Region = "eu" | "us" | "any";

export interface AdapterOptions {
  region?: Region;
  now?: () => number;
}

export type Scalar = string | number | boolean | null;
export type Json = Scalar | Json[] | { [key: string]: Json };
export type Doc = { [key: string]: Json };

export interface Query {
  where?: Record<string, Scalar>;
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string;
}

export interface Page<T extends Doc = Doc> {
  items: { id: string; data: T }[];
  nextCursor?: string;
}

export interface StoreOps {
  get<T extends Doc = Doc>(collection: string, id: string): Promise<T | null>;
  put<T extends Doc = Doc>(collection: string, id: string, doc: T): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  query<T extends Doc = Doc>(collection: string, query?: Query): Promise<Page<T>>;
}

export interface Store extends StoreOps {
  readonly region: Region;
  transaction<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R>;
}

export interface BlobObject {
  data: Uint8Array;
  contentType?: string;
}

export interface Blobs {
  readonly region: Region;
  put(key: string, data: Uint8Array, options?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, options: { method: "GET" | "PUT"; expiresInSeconds: number }): Promise<string>;
}
