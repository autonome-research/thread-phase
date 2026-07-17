import type {
  JobStore as CurrentJobStore,
  PipelineEvent as CurrentPipelineEvent,
} from '@autonome-research/thread-phase';
import type {
  EventRecord,
  GetJobOptions,
  JobOwnership,
  JobRecord,
  JobStore as ReleasedV5JobStore,
  ListJobsOptions,
} from './fixtures/v5.0.0/job-store.js';
import type { PipelineEvent as ReleasedV5PipelineEvent } from './fixtures/v5.0.0/phase.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;

// Bidirectional checks use the independently sourced declaration artifact.
// Either assignment fails if required methods, parameters, or returns drift.
type _CurrentAcceptsReleased = Assert<ReleasedV5JobStore extends CurrentJobStore ? true : false>;
type _ReleasedAcceptsCurrent = Assert<CurrentJobStore extends ReleasedV5JobStore ? true : false>;
type _ExactStoreShape = Assert<Equal<CurrentJobStore, ReleasedV5JobStore>>;
type _ExactPipelineEventShape = Assert<Equal<CurrentPipelineEvent, ReleasedV5PipelineEvent>>;
type _VoidLifecycleReturn = Assert<Equal<
  ReturnType<ReleasedV5JobStore['setCompleted']>,
  Promise<void>
>>;
type _NoOwnedLifecycleMethods = Assert<Equal<
  Extract<
    keyof ReleasedV5JobStore,
    | 'claimRunning'
    | 'finalizeJob'
    | 'finalizeAbandonedIfStale'
    | 'heartbeatOwned'
    | 'enableHeartbeat'
  >,
  never
>>;

/** Minimal structural store implementing only the compatibility artifact. */
export class V5CustomJobStore implements ReleasedV5JobStore {
  private nextJobId = 1;
  private nextEventId = 1;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly events: EventRecord[] = [];

  async createJob(name: string, input: unknown): Promise<string> {
    const id = `v5-${this.nextJobId++}`;
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

  async acquireExclusive(name: string, input: unknown): Promise<string | null> {
    if ([...this.jobs.values()].some((job) => job.name === name && job.status === 'RUNNING')) {
      return null;
    }
    const id = await this.createJob(name, input);
    await this.setRunning(id);
    return id;
  }

  async setRunning(jobId: string, ownership?: JobOwnership): Promise<void> {
    const job = this.requireJob(jobId);
    job.status = 'RUNNING';
    job.startedAt ??= new Date();
    Object.assign(job, ownership);
  }

  async setCompleted(jobId: string, result: unknown): Promise<void> {
    const job = this.requireJob(jobId);
    job.status = 'COMPLETED';
    job.result = result;
    job.completedAt = new Date();
  }

  async setFailed(jobId: string, error: string): Promise<void> {
    const job = this.requireJob(jobId);
    job.status = 'FAILED';
    job.error = error;
    job.completedAt = new Date();
  }

  async heartbeat(jobId: string): Promise<void> {
    this.requireJob(jobId).heartbeatAt = new Date();
  }

  async getJob(jobId: string, _options?: GetJobOptions): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async listJobs(options: ListJobsOptions = {}): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => options.name === undefined || job.name === options.name)
      .filter((job) => options.status === undefined || job.status === options.status)
      .slice(0, options.limit ?? 50);
  }

  async appendEvent(jobId: string, event: ReleasedV5PipelineEvent): Promise<number> {
    const job = this.requireJob(jobId);
    const id = this.nextEventId++;
    this.events.push({ id, jobId, eventType: event.type, data: event, createdAt: new Date() });
    job.eventCount++;
    return id;
  }

  async getEvents(jobId: string, afterId = 0): Promise<EventRecord[]> {
    return this.events.filter((event) => event.jobId === jobId && event.id > afterId);
  }

  close(): void {}

  private requireJob(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);
    return job;
  }
}

const currentFromReleased: CurrentJobStore = new V5CustomJobStore();
const releasedFromCurrent: ReleasedV5JobStore = currentFromReleased;
void releasedFromCurrent;
