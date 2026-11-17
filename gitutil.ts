// Git object primitives: SHA-1, tree/commit/tag build + parse, pkt-line codec,
// pack read/write, reachability. Pure functions over Buffers; no clock, no
// randomness. The wire format follows git's exactly (and the kit's
// git-client.ts, which is the other end of every check).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const FIXTURE_EPOCH_SEC = 1_735_689_600;
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export interface GitObject {
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  readonly data: Buffer;
}

/** The git object id of a raw object body. */
export function hashObject(type: GitObject['type'], data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Compare two tree-entry names the way git does (dirs as if `name/`). */
export function gitCompareNames(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Serialize a tree (entries sorted the git way) to its raw bytes. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((x, y) => gitCompareNames(x, y));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a raw tree into entries, in stored order. Throws on malformed bytes. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space + 1);
    if (space === -1 || nul === -1 || nul + 21 > data.length) {
      throw new Error('tree: malformed entry');
    }
    const mode = data.subarray(offset, space).toString('ascii');
    if (!/^[0-7]+$/.test(mode)) throw new Error('tree: bad mode');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitMeta {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
}

/** Serialize a commit. The message is stored exactly as given (no newline added). */
export function buildCommit(meta: CommitMeta): Buffer {
  const identity = CONFORMANCE_IDENTITY;
  const ts = meta.timestamp ?? FIXTURE_EPOCH_SEC;
  const author = meta.author ?? identity;
  const committer = meta.committer ?? identity;
  const lines = [`tree ${meta.tree}`];
  for (const parent of meta.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author} ${ts} +0000`);
  lines.push(`committer ${committer} ${ts} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${meta.message}`, 'utf8');
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

/** Parse a raw commit. Throws when the tree line is missing or malformed. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  if (split === -1) throw new Error('commit: missing blank line');
  const header = text.slice(0, split);
  const message = text.slice(split + 2);
  const lines = header.split('\n');
  let tree = '';
  const parents: string[] = [];
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('commit: bad tree oid');
  for (const parent of parents) {
    if (!/^[0-9a-f]{40}$/.test(parent)) throw new Error('commit: bad parent oid');
  }
  return { tree, parents, message };
}

export interface TagMeta {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly message: string;
  readonly tagger?: string;
  readonly timestamp?: number;
}

/** Serialize an annotated tag. */
export function buildTag(meta: TagMeta): Buffer {
  const ts = meta.timestamp ?? FIXTURE_EPOCH_SEC;
  const tagger = meta.tagger ?? CONFORMANCE_IDENTITY;
  return Buffer.from(
    `object ${meta.object}\ntype ${meta.type}\ntag ${meta.tag}\ntagger ${tagger} ${ts} +0000\n\n${meta.message}`,
    'utf8',
  );
}

/** Parse an annotated tag's target and type. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

// ---------------------------------------------------------------------------
// pkt-line codec (4 hex digits = length including the header; 0000 flush,
// 0001 delim, 0002 response-end; max 65520 bytes per packet)
// ---------------------------------------------------------------------------

export const PKT_LINE_MAX = 65_520;

/** Encode one pkt-line (a data line, or flush when `data` is null). */
export function pktLine(data: Buffer | null): Buffer {
  if (data === null) return Buffer.from('0000', 'ascii');
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

/** A decoded packet: a data buffer, or 'flush' / 'delim' / 'response-end'. */
export type PktPacket = Buffer | 'flush' | 'delim' | 'response-end';

/** Decode a whole buffer of pkt-lines. Throws on a malformed header. */
export function pktDecodeAll(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line: truncated header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push('flush');
      offset += 4;
    } else if (header === '0001') {
      packets.push('delim');
      offset += 4;
    } else if (header === '0002') {
      packets.push('response-end');
      offset += 4;
    } else {
      const length = Number.parseInt(header, 16);
      if (!Number.isFinite(length) || length < 4 || length > PKT_LINE_MAX || offset + length > buffer.length) {
        throw new Error(`pkt-line: bad length ${header}`);
      }
      packets.push(buffer.subarray(offset + 4, offset + length));
      offset += length;
    }
  }
  return packets;
}

/** Split a buffer at its first flush packet: [packets before, rest]. */
export function pktSplitAtFlush(buffer: Buffer): { packets: PktPacket[]; rest: Buffer } {
  let offset = 0;
  const packets: PktPacket[] = [];
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line: truncated header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      return { packets, rest: buffer.subarray(offset + 4) };
    }
    if (header === '0001' || header === '0002') {
      packets.push(header === '0001' ? 'delim' : 'response-end');
      offset += 4;
      continue;
    }
    const length = Number.parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || length > PKT_LINE_MAX || offset + length > buffer.length) {
      throw new Error(`pkt-line: bad length ${header}`);
    }
    packets.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  throw new Error('pkt-line: no flush');
}

/** Decode a pkt-line stream into lines (stopping at flush/delim/response-end). */
export function pktLinesUntilEnd(packets: readonly PktPacket[]): Buffer[] {
  const lines: Buffer[] = [];
  for (const packet of packets) {
    if (packet === 'flush' || packet === 'delim' || packet === 'response-end') break;
    lines.push(packet);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// packs (version 2; plain objects only — the suite never sends or expects deltas)
// ---------------------------------------------------------------------------

const PACK_TYPE_CODE: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Serialize one object entry: varint header + deflate (level 1: fast, valid). */
export function packObjectEntry(type: GitObject['type'], data: Buffer): Buffer {
  const typeCode = PACK_TYPE_CODE[type];
  const size = data.length;
  const firstByte = (typeCode << 4) | (size & 0x0f);
  const headerBytes: number[] = [];
  let remaining = size >>> 4;
  if (remaining === 0) {
    headerBytes.push(firstByte);
  } else {
    headerBytes.push(firstByte | 0x80);
    while (remaining > 0) {
      const byte = remaining & 0x7f;
      remaining >>>= 7;
      headerBytes.push(remaining === 0 ? byte : byte | 0x80);
    }
  }
  return Buffer.concat([Buffer.from(headerBytes), deflateSync(data, { level: 1 })]);
}

/** Serialize a pack of plain objects, in the given (already deterministic) order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) parts.push(packObjectEntry(object.type, object.data));
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface ParsedPackObject {
  readonly oid: string;
  readonly type: GitObject['type'];
  readonly data: Buffer;
}

/** Parse a version-2 pack of plain objects. Deltas throw (never sent by the suite). */
export function parsePack(buffer: Buffer): ParsedPackObject[] {
  if (buffer.length < 32) throw new Error('pack: too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad magic');
  if (buffer.readUInt32BE(4) !== 2) throw new Error('pack: bad version');
  const count = buffer.readUInt32BE(8);
  const trailer = buffer.subarray(buffer.length - 20);
  const expected = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest();
  if (!trailer.equals(expected)) throw new Error('pack: bad trailer checksum');
  const typeByCode: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const objects: ParsedPackObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= buffer.length - 20) throw new Error('pack: truncated object');
    const first = buffer[offset] as number;
    const typeCode = (first >> 4) & 0x07;
    if (!(typeCode in typeByCode)) throw new Error(`pack: unsupported type code ${typeCode}`);
    const type = typeByCode[typeCode] as GitObject['type'];
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while ((buffer[offset - 1] as number) & 0x80) {
      if (offset >= buffer.length - 20) throw new Error('pack: truncated varint');
      const byte = buffer[offset] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    const { data, consumed } = inflateOne(buffer, offset, buffer.length - 20);
    if (data.length !== size) throw new Error('pack: size mismatch');
    objects.push({ oid: hashObject(type, data), type, data });
    offset += consumed;
  }
  return objects;
}

/**
 * Inflate exactly one deflate stream starting at `offset` (never past `limit`).
 * `inflateSync` ignores trailing bytes but throws on a truncated stream, so
 * the stream's end is the shortest prefix that inflates cleanly — found by
 * binary search (log2(size) small inflations per object).
 */
function inflateOne(buffer: Buffer, offset: number, limit: number): { data: Buffer; consumed: number } {
  try {
    inflateSync(buffer.subarray(offset, limit));
  } catch {
    throw new Error('pack: unterminated deflate stream');
  }
  let lo = offset + 1;
  let hi = limit;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buffer.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buffer.subarray(offset, lo)), consumed: lo - offset };
}

/**
 * Collect every object reachable from `roots` (commits walk trees + parents,
 * tags peel to their target, trees walk entries; gitlinks are skipped).
 * Returns the objects in deterministic (oid-sorted) order.
 */
export function collectReachable(
  roots: readonly string[],
  lookup: (oid: string) => GitObject | undefined,
): GitObject[] {
  const seen = new Map<string, GitObject>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.set(oid, object);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      queue.push(parsed.tree);
      for (const parent of parsed.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, object]) => object);
}

/**
 * Like collectReachable, but the walk never descends into the parents of a
 * commit in `stopAt`. That is what a shallow clone's holder actually has:
 * the boundary commit, its tree and blobs — but not its parents.
 */
export function collectReachablePruned(
  roots: readonly string[],
  stopAt: ReadonlySet<string>,
  lookup: (oid: string) => GitObject | undefined,
): GitObject[] {
  const seen = new Map<string, GitObject>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.set(oid, object);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      queue.push(parsed.tree);
      if (!stopAt.has(oid)) {
        for (const parent of parsed.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, object]) => object);
}
