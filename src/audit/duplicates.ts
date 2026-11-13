import type { RemoteActivity, DuplicatePair, Confidence, Logger } from '../domain/types.js';
import type { Store } from '../persistence/store.js';
import type { StravaClient } from '../integrations/strava.js';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Audit, don't delete. Same-day sessions are NOT duplicates without time overlap.
const SPORT_GROUPS = new Map<string,string>([
  ...['Run','TrailRun','VirtualRun'].map(x=>[x,'running'] as [string,string]),
  ...['Ride','VirtualRide','MountainBikeRide','EMountainBikeRide','EBikeRide','GravelRide','Handcycle'].map(x=>[x,'cycling'] as [string,string]),
  ...['Walk','Hike'].map(x=>[x,'walking'] as [string,string]),
  ...['WeightTraining','Workout','Crossfit','HighIntensityIntervalTraining'].map(x=>[x,'strength'] as [string,string]),
  ...['Swim'].map(x=>[x,'swimming'] as [string,string]),
  ...['Yoga','Pilates'].map(x=>[x,'mindbody'] as [string,string]),
  ...['Rowing','VirtualRow'].map(x=>[x,'rowing'] as [string,string]),
]);
const confidenceRank = { high:0, medium:1, review:2 };
const safeNum = (v: unknown): number | null => v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
const clamp01 = (n: number) => Math.max(0,Math.min(1,n));
const percentage = (n: number | null) => n === null ? 'n/a' : `${Math.round(n*100)}%`;

function category(sport: string | null | undefined): string | null {
  if (!sport) return null;
  const raw = String(sport).trim();
  return SPORT_GROUPS.get(raw) ?? raw.toLowerCase();
}

export function decodePolyline(encoded: string | null | undefined): Array<[number,number]> {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 500000) return [];
  const points: Array<[number,number]> = [];
  const source = encoded as string;
  let index=0, lat=0,lon=0;
  function number() {
    let result=0,shift=0,b;
    do {
      if(index>=source.length || shift>30) throw Error('invalid polyline');
      b=source.charCodeAt(index++)-63;
      if(b<0 || b>63) throw Error('invalid polyline');
      result |= (b&0x1f)<<shift;
      shift+=5;
    } while(b>=0x20);
    return (result&1) ? ~(result>>1) : result>>1;
  }
  try {
    while(index<source.length && points.length<10000) {
      lat+=number();lon+=number();
      const a=lat/1e5,b=lon/1e5;
      if(Math.abs(a)>90 || Math.abs(b)>180) return [];
      points.push([a,b]);
    }
    return points;
  } catch { return []; }
}

const toRad = (x: number) => x*Math.PI/180;
function haversineMeters(a: [number,number],b: [number,number]): number {
  const dlat=toRad(b[0]-a[0]), dlon=toRad(b[1]-a[1]);
  const phi1=toRad(a[0]),phi2=toRad(b[0]);
  const q=Math.sin(dlat/2)**2+Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlon/2)**2;
  return 12742000*Math.asin(Math.sqrt(Math.min(1,q)));
}
function samples<T>(list: T[], count=30): T[] {
  if(list.length<=count) return list;
  return Array.from({length:count},(_,i)=>list[Math.round(i*(list.length-1)/(count-1))]);
}
export function routeAgreement(polyA: string | null | undefined,polyB: string | null | undefined): number | null {
  const a=decodePolyline(polyA),b=decodePolyline(polyB);
  if(a.length<3||b.length<3) return null;
  // Compare spatial coverage both ways, not index-to-index (device GPS sampling differs).
  // A repeated route alone is NOT a duplicate: the detector additionally requires time overlap.
  const sampledA=samples(a),sampledB=samples(b);
  const coverage=(x,y)=>x.filter(p=>y.some(q=>haversineMeters(p,q)<=100)).length/x.length;
  return Math.round(Math.min(coverage(sampledA,sampledB),coverage(sampledB,sampledA))*100)/100;
}

export function evaluatePair(a: RemoteActivity, b: RemoteActivity): DuplicatePair | null {
  if(a?.id == null || b?.id == null || String(a.id)===String(b.id)) return null;
  const sportA=category(a.sport),sportB=category(b.sport);
  if(!sportA || sportA!==sportB) return null;
  const sa=safeNum(a.start_utc),sb=safeNum(b.start_utc);
  const da=safeNum(a.duration_seconds),db=safeNum(b.duration_seconds);
  if(sa===null || sb===null || da===null || db===null || da<60 || db<60) return null;
  const startDelta=Math.abs(sa-sb);
  const overlap=Math.max(0,Math.min(sa+da,sb+db)-Math.max(sa,sb));
  if(overlap<Math.min(90,Math.min(da,db)*0.5)) return null;
  const coverage=overlap/Math.min(da,db);
  const union=overlap/(Math.max(sa+da,sb+db)-Math.min(sa,sb));
  const durationSimilarity=Math.min(da,db)/Math.max(da,db);
  // Avoid flagging one legitimate workout inside a much longer session.
  if(coverage<0.55 || union<0.35 || durationSimilarity<0.4) return null;
  const distA=safeNum(a.distance_m),distB=safeNum(b.distance_m);
  const distSimilarity=(distA!==null && distB!==null && distA>100 && distB>100) ? Math.min(distA,distB)/Math.max(distA,distB) : null;
  const routeSimilarity=routeAgreement(a.route_polyline,b.route_polyline);
  const bothManual=Boolean(a.manual) && Boolean(b.manual);
  let confidence: Confidence = 'review';
  if(union>=0.78 && durationSimilarity>=0.8 && startDelta<=300 && (distSimilarity===null || distSimilarity>=0.78)) confidence='high';
  else if(union>=0.55 && durationSimilarity>=0.65 && startDelta<=900 && (distSimilarity===null || distSimilarity>=0.58)) confidence='medium';
  if(routeSimilarity!==null && routeSimilarity>=0.78 && union>=0.64 && durationSimilarity>=0.65) {
    confidence=union>=0.77 && startDelta<=600 ? 'high' : 'medium';
  }
  // A drastically different route means extra caution, not automatic rejection:
  // polyline redaction and GPS inaccuracies can disagree across watches.
  if(routeSimilarity!==null && routeSimilarity<0.3 && confidence==='high') confidence='medium';
  if(bothManual && confidence==='high') confidence='medium';
  const notes: string[] = [];
  if(startDelta<=300) notes.push('starts within 5 minutes');
  if(union>=0.7) notes.push('strong time-window overlap');
  if(distSimilarity!==null && distSimilarity>=0.8) notes.push('similar distance');
  if(distSimilarity!==null && distSimilarity<0.6) notes.push('substantially different distances');
  if(routeSimilarity!==null && routeSimilarity>=0.78) notes.push('similar mapped route');
  if(routeSimilarity!==null && routeSimilarity<0.3) notes.push('routes differ or are redacted');
  if(bothManual) notes.push('both manual recordings');
  if(!notes.length) notes.push('overlapping recordings; review both');
  return {
    confidence, sportGroup:sportA,
    a:{...a},b:{...b},
    metrics:{overlapSeconds:overlap,overlapOfShorter:clamp01(coverage),overlapOfUnion:clamp01(union),startDeltaSeconds:startDelta,durationSimilarity,distSimilarity,routeSimilarity},
    reasons:notes,
  };
}

export function findDuplicatePairs(activities: RemoteActivity[],{minConfidence='review'}:{minConfidence?: 'high'|'medium'|'review'}={}): DuplicatePair[] {
  if(!(minConfidence in confidenceRank)) throw new Error('minConfidence must be high, medium, or review');
  const rows=activities.filter(a=>safeNum(a.start_utc)!==null && (safeNum(a.duration_seconds) ?? 0)>=60 && category(a.sport))
    .slice().sort((a,b)=>Number(a.start_utc)-Number(b.start_utc));
  const matches: DuplicatePair[]=[];
  // Sweep-line: any potentially overlapping previous recording can match,
  // including activities spanning midnight. Avoid naive O(n²) full history scans.
  const active: RemoteActivity[]=[];
  for(const current of rows) {
    const start=Number(current.start_utc);
    for(let i=active.length-1;i>=0;i--){
      const prev=active[i];
      if(Number(prev.start_utc)+Number(prev.duration_seconds)<=start) active.splice(i,1);
    }
    for(const prev of active) {
      const pair=evaluatePair(prev,current);
      if(pair && confidenceRank[pair.confidence]<=confidenceRank[minConfidence]) matches.push(pair);
    }
    active.push(current);
  }
  return matches.sort((a,b)=>confidenceRank[a.confidence]-confidenceRank[b.confidence] || Number(b.a.start_utc)-Number(a.a.start_utc) || String(a.a.id).localeCompare(String(b.a.id)));
}

const csvCell = (v: unknown) => `"${String(v??'').replaceAll('"','""')}"`;
export function toCsv(pairs: DuplicatePair[]): string {
  const headers=['confidence','date_utc','type','a_id','a_name','a_device','a_start_utc','a_duration_min','a_distance_km','a_url','b_id','b_name','b_device','b_start_utc','b_duration_min','b_distance_km','b_url','start_delta_min','overlap_min','overlap_pct_union','overlap_pct_shorter','distance_similarity_pct','route_agreement_pct','reasons'];
  const minutes=(n: number | null | undefined)=>n==null?'':(Number(n)/60).toFixed(1);
  const kms=(n: number | null | undefined)=>n==null?'':(Number(n)/1000).toFixed(2);
  const rows=pairs.map(p=>{
    const {a,b,metrics:m}=p;
    return [p.confidence,new Date(Number(a.start_utc)*1000).toISOString().slice(0,10),p.sportGroup,
      a.id,a.name,a.device_name,new Date(Number(a.start_utc)*1000).toISOString(),minutes(a.duration_seconds),kms(a.distance_m),`https://www.strava.com/activities/${a.id}`,
      b.id,b.name,b.device_name,new Date(Number(b.start_utc)*1000).toISOString(),minutes(b.duration_seconds),kms(b.distance_m),`https://www.strava.com/activities/${b.id}`,
      minutes(m.startDeltaSeconds),minutes(m.overlapSeconds),percentage(m.overlapOfUnion),percentage(m.overlapOfShorter),percentage(m.distSimilarity),percentage(m.routeSimilarity),p.reasons.join('; ')];
  });
  return [headers,...rows].map(line=>line.map(csvCell).join(',')).join('\n')+'\n';
}

export function saveDuplicateReport(store: Pick<Store,'home'|'getMeta'|'countRemote'>,pairs: DuplicatePair[],{out=null,log=console.log}:{out?:string|null;log?:(line:string)=>void}={}) {
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const base=out ?? join(store.home,'reports',`strava-duplicates-${stamp}`);
  const stem=base.replace(/\.(csv|json)$/i,'');
  const jsonPath=`${stem}.json`,csvPath=`${stem}.csv`;
  const report={generatedAt:new Date().toISOString(),snapshotCompletedAt:store.getMeta('remote_synced_at'),activitiesScanned:store.countRemote(),pairCount:pairs.length,confidence:{high:pairs.filter(p=>p.confidence==='high').length,medium:pairs.filter(p=>p.confidence==='medium').length,review:pairs.filter(p=>p.confidence==='review').length},pairs};
  mkdirSync(dirname(stem),{recursive:true,mode:0o700});
  writeFileSync(jsonPath,JSON.stringify(report,null,2),{mode:0o600});
  writeFileSync(csvPath,toCsv(pairs),{mode:0o600});
  log(`\nReports saved:\n  ${csvPath}\n  ${jsonPath}`);
  return {csvPath,jsonPath};
}

export function printDuplicatePairs(pairs: DuplicatePair[],{totalActivities=0,log=console.log}:{totalActivities?:number;log?:Logger}={}) {
  const n={high:0,medium:0,review:0};
  for(const p of pairs)n[p.confidence]++;
  log(`\nStrava duplicate audit — ${totalActivities} activities checked`);
  log(`  ${pairs.length} overlapping candidate pairs: ${n.high} high, ${n.medium} medium, ${n.review} review.`);
  const first=pairs.slice(0,30);
  for(const p of first) {
    const m=p.metrics;
    const when=new Date(Number(p.a.start_utc)*1000).toISOString().replace('T',' ').slice(0,16)+' UTC';
    log(`\n[${p.confidence.toUpperCase()}] ${when} — ${p.sportGroup}`);
    log(`  ${p.a.name||p.a.sport} (${(Number(p.a.distance_m||0)/1000).toFixed(2)} km)${p.a.device_name?' — '+p.a.device_name:''}`);
    log(`    https://www.strava.com/activities/${p.a.id}`);
    log(`  ${p.b.name||p.b.sport} (${(Number(p.b.distance_m||0)/1000).toFixed(2)} km)${p.b.device_name?' — '+p.b.device_name:''}`);
    log(`    https://www.strava.com/activities/${p.b.id}`);
    log(`  Start Δ ${(m.startDeltaSeconds/60).toFixed(1)} min | overlap ${(m.overlapSeconds/60).toFixed(1)} min (${percentage(m.overlapOfUnion)} of combined window) | distance ${percentage(m.distSimilarity)} similar | route ${percentage(m.routeSimilarity)} agreement`);
  }
  if(pairs.length>first.length)log(`\n...${pairs.length-first.length} more candidate pairs in CSV/JSON.`);
  log('\nNo Strava activities were modified or deleted. These are candidates, not confirmed duplicates.');
}

// Fetch full activity metadata only for suspicious pairs, not the entire history.
// This is optional because it consumes additional Strava read API requests.
export async function enrichCandidateDetails(store: Pick<Store,'remoteById'|'updateRemoteDetail'>,client: Pick<StravaClient,'activityDetail'>,pairs: DuplicatePair[],{max=30,log=console.log}:{max?:number;log?:Logger}={}) {
  if (!Number.isSafeInteger(max) || max<0) throw new Error('max details must be a nonnegative integer');
  const ids=[...new Set(pairs.flatMap(p=>[String(p.a.id),String(p.b.id)]))];
  let fetched=0,cached=0,failed=0,rateLimited=false;
  for(const id of ids) {
    const current=store.remoteById(id);
    if(current?.detail_fetched_at) {cached++;continue;}
    if(fetched>=max) break;
    try {
      const detail=await client.activityDetail(id);
      store.updateRemoteDetail(id,detail);
      fetched++;
    } catch(err) {
      if(err instanceof Error && err.name==='RateLimitPause') {
        rateLimited=true;
        log(`Strava read limit reached during optional detail checks: ${(err instanceof Error ? err.message : String(err))}`);
        break;
      }
      failed++;
      log(`Could not fetch details for ${id}: ${(err instanceof Error ? err.message : String(err))}`);
    }
  }
  log(`Detailed activity checks: ${fetched} fetched, ${cached} cached, ${failed} unavailable${rateLimited?', stopped at Strava rate limit':''}.`);
  return {fetched,cached,failed,rateLimited};
}
