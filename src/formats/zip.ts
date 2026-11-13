/**
 * Bounded ZIP reader for the per-activity archives supplied by Garmin.
 *
 * yauzl validates ZIP entry sizes and streams decompression instead of invoking a
 * platform-specific `unzip` executable. We always cap the *uncompressed* bytes;
 * a compressed ZIP size alone cannot defend against decompression bombs.
 *
 * Paths in the archive are never used as filesystem destinations.
 */
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { writeFileSync } from 'node:fs';

const MAX_ENTRIES = 2_000;

function openArchive(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
    }, (error, archive) => {
      if (error) return reject(error);
      if (!archive) return reject(new Error('Could not open Garmin ZIP archive.'));
      resolve(archive);
    });
  });
}

function safeEntry(name: string): boolean {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) return false;
  return !name.endsWith('/') && !name.startsWith('__MACOSX/');
}

/** Return all safe, non-directory entry names, without extracting files. */
export async function zipEntries(file: string): Promise<string[]> {
  const archive = await openArchive(file);
  console.log('[DEBUGZIP] index opened', archive.entryCount);
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    let seen = 0;
    let complete = false;
    const finish = (error?: Error) => { console.log('[DEBUGZIP] index finish',error?.message);
      if (complete) return;
      complete = true;
      archive.close();
      if (error) reject(error);
      else resolve(names);
    };
    archive.on('error', finish);
    archive.on('end', () => finish());
    archive.on('entry', (entry: Entry) => { console.log('[DEBUGZIP] got entry',entry.fileName);
      if (++seen > MAX_ENTRIES) {
        finish(new Error('Garmin activity ZIP has too many entries.'));
        return;
      }
      if (safeEntry(entry.fileName)) names.push(entry.fileName);
      // Count instead of relying on ZIP's end event, which may not fire
      // when autoClose is disabled or the last entry has already been read.
      if (seen === archive.entryCount) finish();
      else archive.readEntry();
    });
    if (archive.entryCount === 0) finish();
    else archive.readEntry();
  });
}

/**
 * Extract a selected ZIP entry with an explicit decompression limit.
 *
 * @returns Uncompressed bytes, or null if a destination file was requested.
 */
export async function extractEntry(
  file: string, entryName: string, destination: string | null, maxBytes: number,
): Promise<Buffer | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid ZIP extraction size limit.');
  if (!safeEntry(entryName)) throw new Error('Unsafe ZIP entry path.');
  const archive = await openArchive(file);
  console.log('[DEBUGZIP] extract opened', archive.entryCount, entryName);
  return new Promise((resolve, reject) => {
    let complete = false;
    let visited = 0;
    const finish = (error?: Error, bytes?: Buffer | null) => { console.log('[DEBUGZIP] extract finish',error?.message,bytes?.length);
      if (complete) return;
      complete = true;
      archive.close();
      if (error) reject(error);
      else resolve(bytes ?? null);
    };
    archive.on('error', finish);
    archive.on('end', () => finish(new Error(`Missing Garmin ZIP entry: ${entryName}`)));
    archive.on('entry', (entry: Entry) => {
      if (++visited > MAX_ENTRIES) return finish(new Error('Garmin ZIP has too many entries.'));
      if (entry.fileName !== entryName) {
        archive.readEntry();
        return;
      }
      if (entry.uncompressedSize > maxBytes) {
        finish(new Error(`Oversized Garmin ZIP entry: ${entryName}`));
        return;
      }
      archive.openReadStream(entry, async (error, stream) => {
        if (error || !stream) {
          finish(error ?? new Error(`Cannot open Garmin ZIP entry: ${entryName}`));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        try {
          for await (const chunk of stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += bytes.length;
            if (length > maxBytes) {
              stream.destroy();
              throw new Error(`Oversized Garmin ZIP entry: ${entryName}`);
            }
            chunks.push(bytes);
          }
          const bytes = Buffer.concat(chunks, length);
          if (destination) writeFileSync(destination, bytes, { mode: 0o600 });
          finish(undefined, destination ? null : bytes);
        } catch (cause) {
          finish(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    });
    archive.readEntry();
  });
}
