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

// SQLite's persisted activity-file queue, shared by import and upload workflows.
export interface FileRow {
  digest: string;
  path: string;
  original_path: string;
  format: string;
  start_utc: number | null;
  duration_seconds: number | null;
  distance_m: number | null;
  sport: string | null;
  status: string;
  remote_activity_id: string | null;
  upload_id: string | null;
  error: string | null;
  updated_at: string;
}
export interface ActivityFileInput {
  digest: string;
  path: string;
  originalPath: string;
  format: string;
  startUtc?: number | null;
  durationSeconds?: number | null;
  distanceM?: number | null;
  sport?: string | null;
}
export interface GarminRow {
  id: string;
  name: string | null;
  start_utc: number | null;
  duration_seconds: number | null;
  distance_m: number | null;
  sport: string | null;
  file_digest: string | null;
  state: string;
  remote_activity_id: string | null;
  error: string | null;
  file_status: string | null;
  file_remote_id: string | null;
}
export type ComparableActivity = Pick<RemoteActivity,'start_utc'|'duration_seconds'|'distance_m'>;
export interface FitMetadata {
  isActivity: boolean;
  startUtc: number | null;
  durationSeconds: number | null;
  distanceM: number | null;
  sport: string | null;
}

/** Response fields consumed from Garmin's Personal API activity-list endpoint. */
export interface GarminActivityPayload {
  activityId?: number | string | null;
  id?: number | string | null;
  activityName?: string | null;
  name?: string | null;
  startTimeGMT?: string | number | null;
  startTimeUTC?: string | number | null;
  startTimeUtc?: string | number | null;
  duration?: number | string | null;
  elapsedDuration?: number | string | null;
  distance?: number | string | null;
  activityType?: string | {typeKey?:string|null;parentTypeId?:string|number|null} | null;
}
