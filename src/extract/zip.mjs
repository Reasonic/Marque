import zlib from 'node:zlib';

/**
 * Minimal, zero-dependency ZIP entry reader — DOCX and EPUB are ZIP containers,
 * and Node ships DEFLATE (`zlib.inflateRawSync`) but no archive reader.
 *
 * Central-directory based (not local-header scanning), so it tolerates streamed
 * archives whose local headers zero the sizes and defer them to a data
 * descriptor — which real Office writers produce.
 */
const EOCD_SIG = 0x06054b50; // end of central directory
const CEN_SIG = 0x02014b50; // central directory file header

/** @returns {Buffer} the named entry's uncompressed bytes. */
export function readZipEntry(buf, name) {
  // EOCD sits at the end, before an optional (usually empty) comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no EOCD record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let e = 0; e < count && buf.readUInt32LE(p) === CEN_SIG; e++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const exLen = buf.readUInt16LE(p + 30);
    const cmLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + fnLen) === name) {
      const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    p += 46 + fnLen + exLen + cmLen;
  }
  throw new Error(`zip entry not found: ${name}`);
}
