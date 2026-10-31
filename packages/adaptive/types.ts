import type { Scope } from '../core/types.js';

export const PIPELINE_VERSION = 'adaptive-1';
export const SUMMARY_GENERATOR_VERSION = 'workspace-daily-summary-1';

/** WORKSPACES_* and GLOBAL_PROFILE_* are the workspace-first DAG states; PROFILE_RUNNING / PROFILE_COMMITTED are kept as read-compatible aliases. */
export type CycleState = 'WAITING' | 'ELIGIBLE' | 'SNAPSHOTTING' | 'WORKSPACES_RUNNING' | 'WORKSPACES_COMMITTED' | 'GLOBAL_PROFILE_RUNNING' | 'GLOBAL_PROFILE_COMMITTED' | 'DREAM_RUNNING' | 'COMMITTING' | 'COMPLETED' | 'PAUSED' | 'RETRY_WAIT' | 'BLOCKED' | 'FAILED' | 'INVALIDATED';
export const STATE_ALIASES: Record<string, CycleState> = { PROFILE_RUNNING: 'WORKSPACES_RUNNING', PROFILE_COMMITTED: 'GLOBAL_PROFILE_COMMITTED' };
export type StageStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'PAUSED' | 'SKIPPED' | 'INVALIDATED';
export type ErrorCategory = 'MODEL_UNAVAILABLE' | 'CANCELLED_FOR_ACTIVITY' | 'RESOURCE_PRESSURE' | 'POLICY_INVALIDATED' | 'STAGE_FAILED' | 'INTERNAL';
export interface CycleError { category: ErrorCategory; message: string; at: string }
export interface OutputRef { objectId: string; revisionId: string; proposalId?: string }

export interface WorkspaceRecord {
  workspaceId: string; status: StageStatus;
  outcome?: 'NO_ELIGIBLE_CHANGES' | 'INITIAL_BASELINE' | 'SUMMARIZED';
  fromSequenceExclusive: number; toSequenceInclusive: number; manifestHash?: string; idempotencyKey?: string;
  changes?: { added: number; modified: number; deleted: number; restored: number; documents: number };
  summary?: OutputRef;
  insights: { status: 'NOT_STARTED' | 'NOT_NEEDED' | 'COMPLETED' | 'BLOCKED' | 'FAILED'; evidenceIds: string[]; jobKey?: string };
  accepted: OutputRef[]; pendingReview: string[]; rejected: string[];
  attempts: number; error?: CycleError;
}
export interface GlobalRecord {
  status: StageStatus; extraction: 'NOT_STARTED' | 'NOT_NEEDED' | 'COMPLETED' | 'BLOCKED' | 'FAILED';
  evidenceIds: string[]; accepted: OutputRef[]; pendingReview: string[]; rejected: string[];
  promotions: Array<{ preferenceKey: string; workspaces: string[]; status: 'PROPOSED' | 'ACCEPTED' | 'SKIPPED_UNAUTHORIZED' | 'SKIPPED_CONFLICT'; proposalId?: string }>;
  preservedConflicts: string[]; roots?: { PROFILE: string; USER_INSIGHT: string; acceptedInsightRevisions: OutputRef[] };
  attempts: number; error?: CycleError;
}
export interface DreamRecord {
  status: StageStatus; jobKey?: string; proposals: Array<{ proposalId: string; status: string; evidence: Array<{ uri: string; revisionId: string }> }>;
  corpusVisibility?: { watermark: number; eligibleObjects: number; eligibleScopes: string[]; policyVersion: string; retrievalVersion: string; permittedDerived: OutputRef[] };
  trace?: unknown; attempts: number; error?: CycleError;
  /** Set when the stage was deliberately not run (for example Dream is an explicit opt-in and is off); the cycle can still complete. */ skipped?: string;
}
export interface Cycle {
  id: string; kind: 'scheduled' | 'manual'; localDate: string; timezone: string; state: CycleState; stateHistory: Array<{ state: CycleState; at: string; note?: string }>;
  createdAt: string; updatedAt: string; completedAt?: string;
  watermark: number; manifestHash: string; liveObjects: number; policyVersion: string; pipelineVersion: string; modelProvider?: string;
  /** Exactly the post-W exceptions permitted as inputs to later stages, each with the stage that produced it. */
  permittedDerived: Array<OutputRef & { stage: 'WORKSPACE_SUMMARY' | 'WORKSPACE_INSIGHT' | 'GLOBAL_INSIGHT' }>;
  /** Journal sequence ranges committed by this cycle itself; they never count as foreground activity. */
  ownSequenceRanges: Array<[number, number]>;
  workspaces: Record<string, WorkspaceRecord>; global: GlobalRecord; dream: DreamRecord;
  nextRun?: { startLocal: string; mode: string; confidence: number; reason: string };
  accessEvents?: Array<{ at: string; note: string }>;
  attempts: number; /** counts model-backed stage jobs (profile extraction per scope, Dream) in the current run segment; one Dream job issues several model requests */
  budgets: { modelCallsUsed: number; modelCallsMax: number }; error?: CycleError;
  metrics: { pauses: number; resumes: number; activityCancellations: number; stageMs: Record<string, number>; modelCalls?: number };
}

export interface AdaptiveConfig {
  enabled: boolean; paused: boolean;
  timezone: string; targetLocalTime: string; quietStart: string; quietEnd: string;
  mode: 'adaptive' | 'fixed'; minHistoryDays: number; historyWindowDays: number; inactivityMinutes: number; expectedDurationHours: number;
  telemetryRetentionDays: number;
  autoAccept: 'none' | 'low-risk';
  workspaces: { include: string[] | null; exclude: string[] };
  resources: { maxLoadAverage: number; maxRssMiB: number; activityPollMs: number };
  baselineMaxItems: number; maxModelCallsPerCycle: number; dreamMode: 'micro' | 'deep' | 'strategic';
  /** Opt-in, debounced micro Dream after accepted source / insight / wiki changes. Off by default; independent of the daily cycle. */
  micro: { enabled: boolean; debounceMinutes: number; maxPerDay: number; kinds: string[] };
  /** A cycle that has failed this many attempts is quarantined for the rest of its local date instead of being retried forever. */
  deadLetterAfterAttempts: number;
}
export interface Cursors { workspaces: Record<string, number>; global: number; /** last journal sequence examined by the micro-Dream trigger */ micro?: number; /** last journal sequence scanned for purge events */ purge?: number }
export interface DayTelemetry { events: number[]; covered: boolean[] }
export interface Telemetry { days: Record<string, DayTelemetry>; lastTickAt?: string; lastEventSequence: number; learned?: { startLocal: string; changedOn: string; score: number } }
export interface Lease { owner: string; pid: number; cycleId: string; expiresAt: string }
export type SnapshotRef = { cycleId: string; watermark: number; allowPost?: string[] };
export type AuthScope = Scope;

/** Structured, content-free scheduler telemetry (append-only .mdb/adaptive/events.jsonl). Never contains document text, titles or model output. */
export type ScheduleEventType = 'dream_scheduled' | 'dream_claimed' | 'dream_started' | 'dream_completed' | 'dream_skipped' | 'dream_retry' | 'dream_dead_letter' | 'feedback_applied';
export interface ScheduleEvent { at: string; type: ScheduleEventType; runId?: string; jobId?: string; scheduleId?: string; cycleId?: string; trigger?: 'daily' | 'micro' | 'manual'; watermark?: number; fromSequence?: number; toSequence?: number; state?: string; reason?: string; durationMs?: number; attempts?: number; instance?: string; family?: string; label?: string }
