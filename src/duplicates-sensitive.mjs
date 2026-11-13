import { evaluatePair, findDuplicatePairs, routeAgreement } from './duplicates.mjs';

// Broad, read-only review mode. The normal duplicate detector is intentionally
// conservative. This adds plausible overlaps that it excluded, and NEVER
// upgrades an additional candidate above 'review'.
const groups = new Map([
  ...['Run','TrailRun','VirtualRun'].map(x => [x, 'running']),
  ...['Ride','VirtualRide','MountainBikeRide','EMountainBikeRide','EBikeRide','GravelRide','Handcycle'].map(x => [x,'cycling']),
  ...['Walk','Hike'].map(x => [x,'walking']),
  ...['WeightTraining','Workout','Crossfit','HighIntensityIntervalTraining','Elliptical'].map(x => [x,'strength']),
  ...['Swim'].map(x => [x,'swimming']),
  ...['Yoga','Pilates'].map(x => [x,'mindbody']),
  ...['Rowing','VirtualRow'].map(x => [x,'rowing']),
]);
const generic = new Set(['Workout','HighIntensityIntervalTraining','Other']);
const numeric = x => x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x);
const ratio = (x,y) => Math.min(x,y)/Math.max(x,y);
const pairKey = (a,b) => [String(a.id),String(b.id)].sort().join('|');
function group(x) { const s=String(x?.sport ?? ''); return groups.get(s) ?? (s ? s.toLowerCase() : null); }
function broadPair(a,b) {
  const sa=numeric(a.start_utc), sb=numeric(b.start_utc);
  const da=numeric(a.duration_seconds), db=numeric(b.duration_seconds);
  if (sa === null || sb === null || da === null || db === null || da < 60 || db < 60 || String(a.id)===String(b.id)) return null;
  const ga=group(a), gb=group(b);
  if (!ga || !gb) return null;
  const same=ga===gb;
  const possiblyRelabeled=generic.has(String(a.sport)) || generic.has(String(b.sport));
  const startDelta=Math.abs(sa-sb);
  const overlap=Math.max(0,Math.min(sa+da,sb+db)-Math.max(sa,sb));
  const shorter=Math.min(da,db);
  const unionWindow=Math.max(sa+da,sb+db)-Math.min(sa,sb);
  const overlapShort=overlap/shorter;
  const union=overlap/unionWindow;
  const durationSimilarity=ratio(da,db);
  const nearStart=startDelta<=15*60;
  const contained=overlapShort>=0.8 && overlap>=2*60;
  const materiallyOverlapping=overlapShort>=0.4 && overlap>=2*60;
  let reason;
  if (same && (contained || (nearStart && materiallyOverlapping))) {
    reason=contained && durationSimilarity < 0.4
      ? 'short workout fully/mostly contained within longer same-type workout'
      : 'same sport with overlap below strict thresholds';
  } else if (!same && (possiblyRelabeled || (startDelta<=5*60 && union>=0.75)) &&
             startDelta<=12*60 && overlapShort>=0.7 && union>=0.5) {
    reason=`different sport labels (${a.sport} vs ${b.sport}) during the same time window`;
  } else {
    return null;
  }
  const distA=numeric(a.distance_m),distB=numeric(b.distance_m);
  const distSimilarity=distA>100 && distB>100 ? ratio(distA,distB) : null;
  const routeSimilarity=routeAgreement(a.route_polyline,b.route_polyline);
  return {
    confidence:'review',sportGroup:same?ga:`${ga} / ${gb}`,
    a:{...a},b:{...b},
    metrics:{overlapSeconds:overlap,overlapOfShorter:overlapShort,overlapOfUnion:union,
      startDeltaSeconds:startDelta,durationSimilarity,distSimilarity,routeSimilarity},
    reasons:[reason,'SENSITIVE MODE: inspect before acting'],
  };
}

export function findSensitivePairs(activities) {
  const strict=findDuplicatePairs(activities);
  const results=new Map(strict.map(p=>[pairKey(p.a,p.b),p]));
  const rows=activities.filter(a=>numeric(a.start_utc)!==null && numeric(a.duration_seconds)>=60 && group(a))
    .slice().sort((a,b)=>Number(a.start_utc)-Number(b.start_utc));
  const active=[];
  for (const current of rows) {
    const start=Number(current.start_utc);
    for(let i=active.length-1;i>=0;i--) {
      const prev=active[i];
      if(Number(prev.start_utc)+Number(prev.duration_seconds)<start) active.splice(i,1);
    }
    for (const prev of active) {
      const key=pairKey(prev,current);
      if(results.has(key)) continue;
      const candidate=broadPair(prev,current);
      if(candidate) results.set(key,candidate);
    }
    active.push(current);
  }
  const confidenceRank={high:0,medium:1,review:2};
  return [...results.values()].sort((a,b)=>confidenceRank[a.confidence]-confidenceRank[b.confidence] ||
    Number(b.a.start_utc)-Number(a.a.start_utc) || String(a.a.id).localeCompare(String(b.a.id)));
}
