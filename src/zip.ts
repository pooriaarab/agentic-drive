// A small zip writer and reader. Entries are stored without compression. No Zip64.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function writeZip(entries: ZipEntry[], at: number): Uint8Array {
  const d = new Date(at);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: DataView, o: number, n: number) => v.setUint16(o, n, true);
  const u32 = (v: DataView, o: number, n: number) => v.setUint32(o, n, true);
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    if (entry.data.byteLength >= 0xffffffff || offset >= 0xffffffff || entries.length >= 0xffff) throw new Error("zip: export is too large for a plain zip");
    const local = new DataView(new ArrayBuffer(30));
    u32(local, 0, 0x04034b50); u16(local, 4, 20); u16(local, 6, 0x0800); u16(local, 8, 0); u16(local, 10, time); u16(local, 12, date);
    u32(local, 14, crc); u32(local, 18, entry.data.byteLength); u32(local, 22, entry.data.byteLength); u16(local, 26, name.length); u16(local, 28, 0);
    const head = new DataView(new ArrayBuffer(46));
    u32(head, 0, 0x02014b50); u16(head, 4, 20); u16(head, 6, 20); u16(head, 8, 0x0800); u16(head, 10, 0); u16(head, 12, time); u16(head, 14, date);
    u32(head, 16, crc); u32(head, 20, entry.data.byteLength); u32(head, 24, entry.data.byteLength); u16(head, 28, name.length); u32(head, 42, offset);
    parts.push(new Uint8Array(local.buffer), name, entry.data);
    central.push(new Uint8Array(head.buffer), name);
    offset += 30 + name.length + entry.data.byteLength;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  u32(end, 0, 0x06054b50); u16(end, 8, entries.length); u16(end, 10, entries.length); u32(end, 12, size); u32(end, 16, offset);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.byteLength, 0));
  let at2 = 0;
  for (const p of all) { out.set(p, at2); at2 += p.byteLength; }
  return out;
}

/** Reads a zip made by `writeZip`. It checks every CRC. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("zip: no end signature");
  const count = v.getUint16(end + 10, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0, at = v.getUint32(end + 16, true); i < count; i++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("zip: bad central signature");
    if (v.getUint16(at + 10, true) !== 0) throw new Error("zip: compressed entries are not supported");
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error("zip: bad local signature");
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== crc) throw new Error(`zip: crc mismatch in ${name}`);
    out.set(name, data);
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}
