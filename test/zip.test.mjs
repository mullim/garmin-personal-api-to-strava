import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipEntries, extractEntry } from '../dist/formats/zip.js';

test('ZIP extraction streams selected files, enforces size limit and blocks unsafe paths', async () => {
  const home = mkdtempSync(join(tmpdir(), 'g2s-zip-test-'));
  try {
    const dir=join(home,'source');
    mkdirSync(dir);
    const input=Buffer.alloc(2048,42);
    writeFileSync(join(dir,'session.fit'), input);
    const archive=join(home,'workout.zip');
    execFileSync('zip',['-q',archive,'session.fit'],{cwd:dir});
    assert.deepEqual(await zipEntries(archive),['session.fit']);
    assert.deepEqual(await extractEntry(archive,'session.fit',null,4096),input);
    await assert.rejects(extractEntry(archive,'session.fit',null,100),/Oversized/);
    await assert.rejects(extractEntry(archive,'../session.fit',null,4096),/Unsafe/);
    const out=join(home,'restored.fit');
    assert.equal(await extractEntry(archive,'session.fit',out,4096),null);
    assert.deepEqual(readFileSync(out),input);
  } finally { rmSync(home,{recursive:true,force:true}); }
});
