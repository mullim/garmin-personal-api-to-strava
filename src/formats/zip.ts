// Read an individual activity ZIP returned by Garmin's official Personal API.
// Uses macOS's built-in unzip; never expands arbitrary paths onto disk.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export function zipEntries(file) {
  const output = execFileSync('unzip', ['-Z', '-1', file], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return output.split(/\r?\n/).filter(Boolean).filter(e => !e.endsWith('/') && !e.startsWith('__MACOSX/'));
}

export async function extractEntry(zip, entry, destination, maxBytes) {
  const child = spawn('unzip', ['-p', zip, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exitPromise = new Promise<number|null>((resolve,reject) => {child.once('close',resolve);child.once('error',reject);});
  let count=0;
  let stderr='';
  const chunks: Buffer[]=[];
  const sink = destination ? createWriteStream(destination, {mode:0o600}) : null;
  child.stderr.on('data', b => {stderr+=b.toString().slice(0,1000);});
  try {
    for await (const chunk of child.stdout) {
      count+=chunk.length;
      if(count>maxBytes) {child.kill();throw new Error(`Oversized Garmin ZIP entry: ${entry}`);}
      if(sink) {
        if(!sink.write(chunk)) await new Promise<void>(resolve=>sink.once('drain',()=>resolve()));
      } else chunks.push(chunk);
    }
    if(sink) await new Promise<void>((resolve,reject)=>sink.end((err?: Error)=>err?reject(err):resolve()));
    const exit=await exitPromise;
    if(exit!==0) throw new Error(`Could not read ${entry}: ${stderr||`unzip exit ${exit}`}`);
    return destination ? null : Buffer.concat(chunks);
  } catch(err) {
    child.kill();sink?.destroy();
    throw err;
  }
}
