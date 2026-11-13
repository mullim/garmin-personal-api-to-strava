// Minimal read-only FIT inspector. We leave the original binary untouched for Strava.
// It looks at the FIT file_id and session messages so daily wellness files stay out.
const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z
const SPORT = new Map<number,string>([[1,'Run'],[2,'Ride'],[5,'Swim'],[10,'Workout'],[11,'Walk'],[13,'AlpineSki'],[14,'Snowboard'],[15,'Rowing'],[17,'Hike'],[19,'Paddling'],[21,'Sail'],[254,'Workout']]);

export function inspectFit(buffer) {
  if (buffer.length < 14 || buffer.toString('ascii', 8, 12) !== '.FIT') return null;
  const headerSize = buffer[0];
  if (headerSize < 12 || headerSize > buffer.length) return null;
  const dataSize = buffer.readUInt32LE(4);
  if (headerSize + dataSize > buffer.length) return null;
  const end = headerSize + dataSize;
  let pos = headerSize;
  const defs = new Map<number,{ big:boolean; global:number; fields:Array<{num:number;size:number}>; size:number }>();
  let fileType = null;
  let sawSession = false;
  let startUtc: number | null = null;
  let durationSeconds: number | null = null;
  let distanceM: number | null = null;
  let sport: string | null = null;
  function readField(bytes, def, num) {
    const field = def.fields.find(f => f.num === num);
    if (!field || field.size < bytesFor(def, field)) return null;
    const start = def.fields.slice(0, def.fields.indexOf(field)).reduce((s, f) => s + f.size, 0);
    if (start + field.size > bytes.length) return null;
    const b = bytes.subarray(start, start + field.size);
    const size = field.size;
    const unsigned = def.big ? (n) => b.readUIntBE(0, n) : (n) => b.readUIntLE(0, n);
    if (size === 1) return b[0] === 0xff ? null : b[0];
    if (size === 2) { const v = unsigned(2); return v === 0xffff ? null : v; }
    if (size === 4) { const v = unsigned(4); return v === 0xffffffff ? null : v; }
    return null;
  }
  // Field-specific interpretation only depends on width, not generic FIT scale profile.
  function bytesFor(_def, field) { return field.size; }
  try {
    while (pos < end) {
      const hdr = buffer[pos++];
      if ((hdr & 0x80) === 0 && (hdr & 0x40)) {
        const local = hdr & 0x0f;
        if (pos + 5 > end) return null;
        const big = buffer[pos + 1] === 1;
        const global = big ? buffer.readUInt16BE(pos + 2) : buffer.readUInt16LE(pos + 2);
        const count = buffer[pos + 4];
        pos += 5;
        const fields: Array<{num:number;size:number}> = [];
        for (let i = 0; i < count; i++) {
          if (pos + 3 > end) return null;
          fields.push({ num: buffer[pos], size: buffer[pos + 1] });
          pos += 3;
        }
        let devSize = 0;
        if (hdr & 0x20) {
          if (pos >= end) return null;
          const devCount = buffer[pos++];
          for (let i = 0; i < devCount; i++) {
            if (pos + 3 > end) return null;
            devSize += buffer[pos + 1];
            pos += 3;
          }
        }
        defs.set(local, { big, global, fields, size: fields.reduce((s,f) => s+f.size,0)+devSize });
      } else {
        const local = (hdr & 0x80) ? ((hdr >> 5) & 0x03) : (hdr & 0x0f);
        const def = defs.get(local);
        if (!def || pos + def.size > end) return null;
        const msg = buffer.subarray(pos, pos + def.size);
        pos += def.size;
        if (def.global === 0) fileType = readField(msg, def, 0);
        if (def.global === 18) {
          sawSession = true;
          const started = readField(msg, def, 2);
          if (started != null) startUtc = started + FIT_EPOCH;
          const elapsed = readField(msg, def, 7);
          if (elapsed != null) durationSeconds = elapsed / 1000;
          const distance = readField(msg, def, 9);
          if (distance != null) distanceM = distance / 100;
          const sportCode = readField(msg, def, 5);
          if (sportCode != null) sport = SPORT.get(sportCode) ?? `Sport ${sportCode}`;
        }
      }
    }
  } catch { return null; }
  return { isActivity: fileType === 4 || sawSession, fileType, sawSession, startUtc, durationSeconds, distanceM, sport };
}

export function inspectXml(buffer, extension) {
  const xml = buffer.toString('utf8');
  if (extension === 'gpx' && !/<(?:\w+:)?gpx[\s>]/i.test(xml)) return null;
  if (extension === 'tcx' && !/<(?:\w+:)?TrainingCenterDatabase[\s>]/i.test(xml)) return null;
  if (extension === 'gpx' && !/<(?:\w+:)?trk[\s>]/i.test(xml)) return null;
  if (extension === 'tcx' && !/<(?:\w+:)?Activity[\s>]/i.test(xml)) return null;
  const time = xml.match(/<(?:\w+:)?(?:time|Id)>(\d{4}-\d\d-\d\dT[^<]+)<\/(?:\w+:)?(?:time|Id)>/i)?.[1];
  const date = time ? Date.parse(time) / 1000 : null;
  return { isActivity: true, startUtc: Number.isFinite(date) ? date : null,
    durationSeconds: null, distanceM: null, sport: null };
}
