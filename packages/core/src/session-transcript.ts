import { constants, type BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { WorkflowAgentSessionReference } from "./types.js";
import { object } from "./utils.js";

/** Bytes read per chunk when the pane opens and per loadEarlier call; longer lines are returned as `large` records, read only by loadRecord. */
const TRANSCRIPT_CHUNK_BYTES = 4 * 1024 * 1024;
/** Bytes per read while looking for the newline of a line longer than the chunk. */
const SCAN_BLOCK_BYTES = 64 * 1024;
/** loadRecord returns a longer record unreadable without allocating it. */
const LOAD_LIMIT_BYTES = 64 * 1024 * 1024;
/** Pi bounds its own session header scan to 1 MiB (MAX_SESSION_HEADER_SCAN_BYTES). */
const HEADER_LIMIT_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
//NOTE: Windows has no O_NONBLOCK; there the open is a plain read-only open.
const { O_NONBLOCK = 0 } = constants as Partial<typeof constants>;
const OPEN_FLAGS = constants.O_RDONLY | O_NONBLOCK;

/** One line of the session file, in file order. `offset` and `bytes` cover the line without its newline. */
export type TranscriptRecord =
  | { readonly kind: "entry"; readonly offset: number; readonly bytes: number; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: "large"; readonly offset: number; readonly bytes: number }
  | { readonly kind: "unreadable"; readonly offset: number; readonly bytes: number };

/**
 * `waiting`: no file yet (pi writes a session file lazily) or the reference has no locator while the agent may still
 * write one. `unavailable`: the file failed the identity checks or cannot be read; `reason` says why.
 */
export type TranscriptSourceStatus = "waiting" | "available" | "unavailable";

export interface TranscriptPoll {
  readonly status: TranscriptSourceStatus;
  /** The source started over (the path now names another file, or the file shrank): drop every record shown so far. */
  readonly reset: boolean;
  /** After a reset or on the first available poll: the last chunk. Otherwise: complete lines appended since the previous poll. */
  readonly appended: readonly TranscriptRecord[];
  /** The earliest record loaded so far starts at byte 0. */
  readonly atStart: boolean;
  readonly reason?: string;
}

/**
 * Callers never overlap calls on one source. Every read goes through the one descriptor the identity checks ran on.
 * A trailing line without a newline is not returned until it is complete.
 */
export interface TranscriptSource {
  poll(): Promise<TranscriptPoll>;
  /** The chunk before the earliest loaded record, starting at a line boundary; empty when already at the start. */
  loadEarlier(): Promise<{ readonly records: readonly TranscriptRecord[]; readonly atStart: boolean }>;
  /** Reads one `large` record in full; returns an `entry` or an `unreadable` record for the same range, `unreadable` unread above 64 MiB. */
  loadRecord(record: { readonly offset: number; readonly bytes: number }): Promise<TranscriptRecord>;
  /** Closes the descriptor; later calls return status `unavailable`. */
  close(): Promise<void>;
}

interface OpenFile { readonly handle: FileHandle; readonly dev: bigint; readonly ino: bigint; size: number; start: number; end: number; scanned: number; pending: Buffer }
interface Closed { readonly status: "waiting" | "unavailable"; readonly reason?: string }

function errorCode(error: unknown): string | undefined { return object(error) && typeof error.code === "string" ? error.code : undefined; }
function unavailable(reason: string): Closed { return { status: "unavailable", reason }; }
function failure(error: unknown): Closed { return unavailable(`cannot read the session file (${errorCode(error) ?? (error instanceof Error ? error.message : String(error))})`); }
function sessionFilePath(reference: WorkflowAgentSessionReference | undefined): string | undefined {
  const locator = reference?.locator;
  return object(locator) && typeof locator.sessionFile === "string" && locator.sessionFile !== "" ? locator.sessionFile : undefined;
}
function parseValue(line: Buffer): unknown { try { return JSON.parse(line.toString("utf8")); } catch { return undefined; } }
function parseRecord(line: Buffer, offset: number): TranscriptRecord {
  const value = parseValue(line);
  return object(value) ? { kind: "entry", offset, bytes: line.length, value } : { kind: "unreadable", offset, bytes: line.length };
}

let readObserver: ((bytes: number) => void) | undefined;
/** Test hook: `observer` receives the byte count of every read the readers make; undefined removes it. */
export function observeSessionTranscriptReads(observer: ((bytes: number) => void) | undefined): void { readObserver = observer; }

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  readObserver?.(filled);
  return buffer.subarray(0, filled);
}
/** Position of the first newline in [from, to), read in blocks; -1 when there is none. */
async function newlineAfter(handle: FileHandle, from: number, to: number): Promise<number> {
  for (let position = from; position < to; position += SCAN_BLOCK_BYTES) {
    const block = await readAt(handle, position, Math.min(SCAN_BLOCK_BYTES, to - position));
    const index = block.indexOf(NEWLINE);
    if (index !== -1) return position + index;
  }
  return -1;
}
/** Position of the last newline in [0, to), read backward in blocks; -1 when there is none. */
async function newlineBefore(handle: FileHandle, to: number): Promise<number> {
  for (let end = to; end > 0; end -= SCAN_BLOCK_BYTES) {
    const position = Math.max(0, end - SCAN_BLOCK_BYTES);
    const index = (await readAt(handle, position, end - position)).lastIndexOf(NEWLINE);
    if (index !== -1) return position + index;
  }
  return -1;
}

/** Opens `path` once and runs the identity checks on that descriptor; on success the descriptor is the only way the file is read. */
async function openChecked(path: string, sessionId: string): Promise<OpenFile | Closed> {
  let handle: FileHandle;
  try { handle = await open(path, OPEN_FLAGS); } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { status: "waiting" };
    if (code === "EACCES" || code === "EPERM") return unavailable("the session file is not readable");
    return failure(error);
  }
  const rejected = async (closed: Closed): Promise<Closed> => { await handle.close().catch(() => undefined); return closed; };
  try {
    const stats: BigIntStats = await handle.stat({ bigint: true });
    if (!stats.isFile()) return await rejected(unavailable("the session path is not a regular file"));
    const size = Number(stats.size);
    const headerEnd = await newlineAfter(handle, 0, Math.min(size, HEADER_LIMIT_BYTES + 1));
    if (headerEnd === -1) return await rejected(size <= HEADER_LIMIT_BYTES ? { status: "waiting" } : unavailable("the session header is longer than 1 MiB"));
    const header = parseValue(await readAt(handle, 0, headerEnd));
    if (!object(header) || header.type !== "session" || typeof header.id !== "string") return await rejected(unavailable("the file does not start with a pi session header"));
    if (header.id !== sessionId) return await rejected(unavailable("the file belongs to another session"));
    return { handle, dev: stats.dev, ino: stats.ino, size, start: 0, end: 0, scanned: 0, pending: Buffer.alloc(0) };
  } catch (error) { return await rejected(failure(error)); }
}

/**
 * The transcript of one pi session file. Reads the last chunk first, earlier chunks on request and complete lines appended
 * since the previous poll; lines longer than the chunk stay unread until loadRecord.
 */
export function openSessionTranscript(reference: WorkflowAgentSessionReference | undefined, options: { chunkBytes?: number } = {}): TranscriptSource {
  const chunkBytes = options.chunkBytes ?? TRANSCRIPT_CHUNK_BYTES;
  const path = sessionFilePath(reference);
  let closed = false;
  let file: OpenFile | undefined;

  /** Appends a record per line of `buffer`, which ends with a newline; `base` is the file offset of buffer[0]. */
  const pushLines = (records: TranscriptRecord[], buffer: Buffer, base: number): void => {
    let start = 0;
    for (let index = buffer.indexOf(NEWLINE); index !== -1; index = buffer.indexOf(NEWLINE, start)) {
      const line = buffer.subarray(start, index);
      records.push(line.length > chunkBytes ? { kind: "large", offset: base + start, bytes: line.length } : parseRecord(line, base + start));
      start = index + 1;
    }
  };
  /** The lines before `limit` (a line boundary) that fit in one chunk, or the one longer line ending there. */
  const chunkBefore = async (handle: FileHandle, limit: number): Promise<{ records: TranscriptRecord[]; start: number }> => {
    // The window also holds the newline ending the chunk and the byte before its first line, so a line of exactly chunkBytes fits.
    const base = Math.max(0, limit - chunkBytes - 2);
    //NOTE: a short read means the file shrank since the last poll; the next poll resets.
    const buffer = await readAt(handle, base, limit - base);
    const records: TranscriptRecord[] = [];
    const first = base === 0 ? -1 : buffer.indexOf(NEWLINE);
    if (base === 0 || (first !== -1 && first < buffer.length - 1)) {
      pushLines(records, buffer.subarray(first + 1), base + first + 1);
      return { records, start: base + first + 1 };
    }
    const start = await newlineBefore(handle, base) + 1;
    records.push({ kind: "large", offset: start, bytes: limit - 1 - start });
    return { records, start };
  };
  /**
   * Complete lines of [from, size) given `pending`, the bytes already read after `from` (the start of a line without a newline yet; empty once that line is longer than a chunk).
   * Every byte from `scanned` to `size` is read once, so a poll reads the growth, never the whole file.
   */
  const linesFrom = async (handle: FileHandle, from: number, scanned: number, pending: Buffer, size: number): Promise<{ records: TranscriptRecord[]; end: number; scanned: number; pending: Buffer }> => {
    const records: TranscriptRecord[] = [];
    let lineStart = from;
    // The parts of the unfinished line, joined once: at its newline or when the poll returns.
    let held: Buffer[] = [pending];
    let position = scanned;
    while (position < size) {
      const block = await readAt(handle, position, Math.min(SCAN_BLOCK_BYTES, size - position));
      if (block.length === 0) break;
      const base = position;
      position += block.length;
      let segment = 0;
      for (let index = block.indexOf(NEWLINE); index !== -1; index = block.indexOf(NEWLINE, segment)) {
        const newline = base + index;
        if (newline - lineStart > chunkBytes) records.push({ kind: "large", offset: lineStart, bytes: newline - lineStart });
        else pushLines(records, Buffer.concat([...held, block.subarray(segment, index + 1)]), lineStart);
        held = [];
        lineStart = newline + 1;
        segment = index + 1;
      }
      if (position - lineStart > chunkBytes) held = [];
      else held.push(block.subarray(segment));
    }
    return { records, end: lineStart, scanned: position, pending: Buffer.concat(held) };
  };
  const drop = async (): Promise<void> => {
    const current = file;
    file = undefined;
    await current?.handle.close().catch(() => undefined);
  };
  const closedPoll = (closedState: Closed, reset: boolean): TranscriptPoll => ({ status: closedState.status, reset, appended: [], atStart: true, ...(closedState.reason === undefined ? {} : { reason: closedState.reason }) });
  const openPoll = async (filePath: string, sessionId: string, reset: boolean): Promise<TranscriptPoll> => {
    const opened = await openChecked(filePath, sessionId);
    if (!("handle" in opened)) return closedPoll(opened, reset);
    file = opened;
    const end = await newlineBefore(opened.handle, opened.size) + 1;
    const chunk = await chunkBefore(opened.handle, end);
    opened.start = chunk.start;
    opened.end = end;
    // The unterminated tail is read once now; a later poll continues after it.
    opened.scanned = opened.size;
    opened.pending = opened.size - end <= chunkBytes ? await readAt(opened.handle, end, opened.size - end) : Buffer.alloc(0);
    return { status: "available", reset, appended: chunk.records, atStart: chunk.start === 0 };
  };
  const poll = async (filePath: string, sessionId: string): Promise<TranscriptPoll> => {
    const current = file;
    if (current === undefined) return openPoll(filePath, sessionId, false);
    const descriptor = await current.handle.stat({ bigint: true });
    const named = await stat(filePath, { bigint: true }).catch(() => undefined);
    const size = Number(descriptor.size);
    // Pi appends to a session file it wrote, but rewrites one in place when it migrates an older session version on open, and another file can be renamed over the path.
    //NOTE: a rewrite in place that leaves the file at least as long as before is not detected.
    if (named === undefined || named.dev !== current.dev || named.ino !== current.ino || size < current.size) {
      await drop();
      return openPoll(filePath, sessionId, true);
    }
    if (size === current.size) return { status: "available", reset: false, appended: [], atStart: current.start === 0 };
    current.size = size;
    const appended = await linesFrom(current.handle, current.end, current.scanned, current.pending, size);
    current.pending = appended.pending;
    current.scanned = appended.scanned;
    current.end = appended.end;
    return { status: "available", reset: false, appended: appended.records, atStart: current.start === 0 };
  };

  return {
    async poll() {
      if (closed) return closedPoll(unavailable("the transcript source is closed"), false);
      if (path === undefined || reference === undefined) return closedPoll({ status: "waiting" }, false);
      const hadFile = file !== undefined;
      try { return await poll(path, reference.sessionId); } catch (error) {
        await drop();
        return closedPoll(failure(error), hadFile);
      }
    },
    async loadEarlier() {
      const current = file;
      if (closed || current === undefined || current.start === 0) return { records: [], atStart: true };
      const chunk = await chunkBefore(current.handle, current.start);
      current.start = chunk.start;
      return { records: chunk.records, atStart: chunk.start === 0 };
    },
    async loadRecord(record) {
      const current = file;
      const buffer = closed || current === undefined || record.bytes > LOAD_LIMIT_BYTES ? undefined : await readAt(current.handle, record.offset, record.bytes);
      return buffer?.length === record.bytes ? parseRecord(buffer, record.offset) : { kind: "unreadable", offset: record.offset, bytes: record.bytes };
    },
    async close() {
      closed = true;
      await drop();
    },
  };
}
