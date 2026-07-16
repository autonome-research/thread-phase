import type {
  EventRecord,
  GetJobOptions,
  JobFinalization,
  JobOwnership,
  JobRecord,
  JobStatus,
  JobStore,
  ListJobsOptions,
  PipelineEvent,
} from '@autonome-research/thread-phase';

/**
 * Verbatim structural copy of the JobStore declarations released in v5.0.0.
 * Keep this independent of the current declarations: exact type assertions
 * below make any parameter or return-value drift fail the test-d typecheck.
 */
type ReleasedV5JobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ABANDONED'
  | 'STALE';

interface ReleasedV5JobRecord {
  id: string;
  name: string;
  input: unknown;
  status: ReleasedV5JobStatus;
  result: unknown | null;
  error: string | null;
  eventCount: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  sessionId?: string;
  pid?: number;
  ppid?: number;
  cwd?: string;
  hostname?: string;
  ownerId?: string;
  launchSource?: string;
  heartbeatEnabled?: boolean;
  heartbeatAt?: Date;
}

interface ReleasedV5EventRecord {
  id: number;
  jobId: string;
  eventType: string;
  data: PipelineEvent;
  createdAt: Date;
}

interface ReleasedV5JobOwnership {
  sessionId?: string;
  pid?: number;
  ppid?: number;
  cwd?: string;
  hostname?: string;
  ownerId?: string;
  launchSource?: string;
  heartbeatEnabled?: boolean;
}

interface ReleasedV5JobFinalization {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ABANDONED';
  result?: unknown;
  error?: string;
  event: PipelineEvent;
  ownerId?: string;
}

interface ReleasedV5ListJobsOptions {
  name?: string;
  limit?: number;
  status?: ReleasedV5JobStatus;
  staleAfterMs?: number;
}

interface ReleasedV5GetJobOptions {
  staleAfterMs?: number;
}

interface ReleasedV5JobStore {
  createJob(name: string, input: unknown): Promise<string>;
  acquireExclusive(name: string, input: unknown): Promise<string | null>;
  setRunning(jobId: string, ownership?: ReleasedV5JobOwnership): Promise<boolean>;
  setCompleted(jobId: string, result: unknown, ownerId?: string): Promise<boolean>;
  setFailed(jobId: string, error: string, ownerId?: string): Promise<boolean>;
  setCancelled(jobId: string, reason: string, ownerId?: string): Promise<boolean>;
  setAbandoned(jobId: string, reason: string): Promise<boolean>;
  setAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<boolean>;
  finalizeJob(
    jobId: string,
    finalization: ReleasedV5JobFinalization,
  ): Promise<ReleasedV5EventRecord | null>;
  finalizeAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<ReleasedV5EventRecord | null>;
  heartbeat(jobId: string, ownerId?: string): Promise<void>;
  enableHeartbeat(jobId: string, ownerId: string): Promise<boolean>;
  getJob(jobId: string, options?: ReleasedV5GetJobOptions): Promise<ReleasedV5JobRecord | null>;
  listJobs(options?: ReleasedV5ListJobsOptions): Promise<ReleasedV5JobRecord[]>;
  appendEvent(jobId: string, event: PipelineEvent): Promise<number>;
  getEvents(jobId: string, afterId?: number): Promise<ReleasedV5EventRecord[]>;
  close(): void | Promise<void>;
}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;

type _StatusIsExact = Assert<Equal<JobStatus, ReleasedV5JobStatus>>;
type _RecordIsExact = Assert<Equal<JobRecord, ReleasedV5JobRecord>>;
type _EventRecordIsExact = Assert<Equal<EventRecord, ReleasedV5EventRecord>>;
type _OwnershipIsExact = Assert<Equal<JobOwnership, ReleasedV5JobOwnership>>;
type _FinalizationIsExact = Assert<Equal<JobFinalization, ReleasedV5JobFinalization>>;
type _ListOptionsAreExact = Assert<Equal<ListJobsOptions, ReleasedV5ListJobsOptions>>;
type _GetOptionsAreExact = Assert<Equal<GetJobOptions, ReleasedV5GetJobOptions>>;
type _StoreIsExact = Assert<Equal<JobStore, ReleasedV5JobStore>>;
type _ClaimReturnIsBoolean = Assert<Equal<ReturnType<JobStore['setRunning']>, Promise<boolean>>>;
type _HeartbeatIsOwnerAware = Assert<
  Equal<JobStore['heartbeat'], (jobId: string, ownerId?: string) => Promise<void>>
>;
type _TerminalCasIsBoolean = Assert<
  Equal<ReturnType<JobStore['setCompleted']>, Promise<boolean>>
>;
type _AtomicFinalizationReturnIsExact = Assert<
  Equal<ReturnType<JobStore['finalizeJob']>, Promise<EventRecord | null>>
>;

/** In-memory custom implementation of the exact released v5.0.0 contract. */
export class V5CustomJobStore implements ReleasedV5JobStore {
  private nextJobId = 1;
  private nextEventId = 1;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly events: EventRecord[] = [];

  async createJob(name: string, input: unknown): Promise<string> {
    return this.createRecord(name, input);
  }

  async acquireExclusive(name: string, input: unknown): Promise<string | null> {
    if ([...this.jobs.values()].some((job) => job.name === name && job.status === 'RUNNING')) {
      return null;
    }
    const id = this.createRecord(name, input);
    const job = this.requireJob(id);
    job.status = 'RUNNING';
    job.startedAt = new Date();
    return id;
  }

  async setRunning(jobId: string, ownership?: JobOwnership): Promise<boolean> {
    const job = this.requireJob(jobId);
    const ownerId = ownership?.ownerId;
    if (
      job.status !== 'PENDING' &&
      !(job.status === 'RUNNING' && (job.ownerId === undefined || job.ownerId === ownerId))
    ) {
      return false;
    }
    job.status = 'RUNNING';
    job.startedAt ??= new Date();
    job.heartbeatAt ??= new Date();
    Object.assign(job, withoutUndefined(ownership));
    return true;
  }

  async setCompleted(jobId: string, result: unknown, ownerId?: string): Promise<boolean> {
    return this.transition(jobId, 'COMPLETED', result, null, ownerId);
  }

  async setFailed(jobId: string, error: string, ownerId?: string): Promise<boolean> {
    return this.transition(jobId, 'FAILED', undefined, error, ownerId);
  }

  async setCancelled(jobId: string, reason: string, ownerId?: string): Promise<boolean> {
    return this.transition(jobId, 'CANCELLED', undefined, reason, ownerId);
  }

  async setAbandoned(jobId: string, reason: string): Promise<boolean> {
    const job = this.requireJob(jobId);
    if (job.status !== 'RUNNING') return false;
    job.status = 'ABANDONED';
    job.error = reason;
    job.completedAt = new Date();
    return true;
  }

  async setAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<boolean> {
    return this.abandonIfStale(jobId, staleBefore, reason, expectedOwnerId);
  }

  async finalizeJob(jobId: string, finalization: JobFinalization): Promise<EventRecord | null> {
    const changed = this.transition(
      jobId,
      finalization.status,
      finalization.result,
      finalization.error ?? null,
      finalization.ownerId,
    );
    return changed ? this.appendRecord(jobId, finalization.event) : null;
  }

  async finalizeAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<EventRecord | null> {
    const changed = this.abandonIfStale(jobId, staleBefore, reason, expectedOwnerId);
    return changed ? this.appendRecord(jobId, { type: 'abandoned', reason }) : null;
  }

  async heartbeat(jobId: string, ownerId?: string): Promise<void> {
    const job = this.requireJob(jobId);
    if (job.status === 'RUNNING' && (ownerId === undefined || job.ownerId === ownerId)) {
      job.heartbeatAt = new Date();
    }
  }

  async enableHeartbeat(jobId: string, ownerId: string): Promise<boolean> {
    const job = this.requireJob(jobId);
    if (job.status !== 'RUNNING' || job.ownerId !== ownerId) return false;
    job.heartbeatEnabled = true;
    job.heartbeatAt = new Date();
    return true;
  }

  async getJob(jobId: string, options: GetJobOptions = {}): Promise<JobRecord | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (
      options.staleAfterMs !== undefined &&
      job.status === 'RUNNING' &&
      job.heartbeatEnabled === true &&
      (job.heartbeatAt === undefined || Date.now() - job.heartbeatAt.getTime() > options.staleAfterMs)
    ) {
      return { ...job, status: 'STALE' };
    }
    return { ...job };
  }

  async listJobs(options: ListJobsOptions = {}): Promise<JobRecord[]> {
    const records = await Promise.all(
      [...this.jobs.keys()].map((id) => this.getJob(id, { staleAfterMs: options.staleAfterMs })),
    );
    return records
      .filter((job): job is JobRecord => job !== null)
      .filter((job) => options.name === undefined || job.name === options.name)
      .filter((job) => options.status === undefined || job.status === options.status)
      .slice(0, options.limit ?? 50);
  }

  async appendEvent(jobId: string, event: PipelineEvent): Promise<number> {
    return this.appendRecord(jobId, event).id;
  }

  async getEvents(jobId: string, afterId = 0): Promise<EventRecord[]> {
    return this.events.filter((event) => event.jobId === jobId && event.id > afterId);
  }

  close(): void {}

  private createRecord(name: string, input: unknown): string {
    const id = `custom-${this.nextJobId++}`;
    this.jobs.set(id, {
      id,
      name,
      input,
      status: 'PENDING',
      result: null,
      error: null,
      eventCount: 0,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    });
    return id;
  }

  private abandonIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): boolean {
    const job = this.requireJob(jobId);
    if (
      job.status !== 'RUNNING' ||
      job.heartbeatEnabled !== true ||
      (job.heartbeatAt !== undefined && job.heartbeatAt >= staleBefore) ||
      (expectedOwnerId !== undefined && job.ownerId !== expectedOwnerId)
    ) {
      return false;
    }
    job.status = 'ABANDONED';
    job.error = reason;
    job.completedAt = new Date();
    return true;
  }

  private transition(
    jobId: string,
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ABANDONED',
    result: unknown,
    error: string | null,
    ownerId?: string,
  ): boolean {
    const job = this.requireJob(jobId);
    if (
      (job.status !== 'PENDING' && job.status !== 'RUNNING') ||
      (ownerId !== undefined && job.ownerId !== ownerId)
    ) {
      return false;
    }
    job.status = status;
    if (result !== undefined) job.result = result;
    job.error = error;
    job.completedAt = new Date();
    return true;
  }

  private appendRecord(jobId: string, event: PipelineEvent): EventRecord {
    const job = this.requireJob(jobId);
    const record: EventRecord = {
      id: this.nextEventId++,
      jobId,
      eventType: event.type,
      data: event,
      createdAt: new Date(),
    };
    this.events.push(record);
    job.eventCount++;
    return record;
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);
    return job;
  }
}

function withoutUndefined(ownership: JobOwnership | undefined): JobOwnership {
  return Object.fromEntries(
    Object.entries(ownership ?? {}).filter(([, value]) => value !== undefined),
  ) as JobOwnership;
}

const exactV5Store: JobStore = new V5CustomJobStore();
const status: JobStatus = 'RUNNING';
void exactV5Store;
void status;
