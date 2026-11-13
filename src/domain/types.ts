/**
 * Canonical domain contracts. Database rows use snake_case for backwards compatibility
 * with the SQLite schema created by the original JavaScript CLI.
 */
export interface GarminActivity {
  id: string;
  name: string;
  startUtc: number | null;
  durationSeconds: number | null;
  distanceM: number | null;
  sport: string | null;
}
export interface RemoteActivity {
  id: string;
  start_utc: number | null;
  duration_seconds: number | null;
  distance_m: number | null;
  sport: string | null;
  name?: string | null;
  device_name?: string | null;
  route_polyline?: string | null;
  manual?: number | boolean | null;
  moving_seconds?: number | null;
  detail_fetched_at?: string | null;
}
export interface StravaActivitySummary {
  id?: number;
  id_str?: string;
  start_date?: string;
  elapsed_time?: number;
  moving_time?: number;
  distance?: number;
  name?: string;
  sport_type?: string;
  type?: string;
  map?: { summary_polyline?: string | null };
  manual?: boolean;
}
export interface StravaActivityDetail extends StravaActivitySummary {
  device_name?: string;
  map?: { summary_polyline?: string | null; polyline?: string | null };
}
export interface StravaUploadResponse {
  id?: number; id_str?: string;
  activity_id?: number; activity_id_str?: string;
  status?: string; error?: string | null;
}
export type Confidence = 'high' | 'medium' | 'review';
export interface DuplicateMetrics {
  overlapSeconds: number;
  overlapOfShorter: number;
  overlapOfUnion: number;
  startDeltaSeconds: number;
  durationSimilarity: number;
  distSimilarity: number | null;
  routeSimilarity: number | null;
}
export interface DuplicatePair {
  confidence: Confidence;
  sportGroup: string;
  a: RemoteActivity;
  b: RemoteActivity;
  metrics: DuplicateMetrics;
  reasons: string[];
}
/** Callback passed to workflows, enabling silent tests and structured logging later. */
export type Logger = (line: string) => void;
