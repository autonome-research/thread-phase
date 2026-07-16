import type {
  EventRecord,
  GetJobOptions,
  JobOwnership,
  JobRecord,
  JobStatus,
  JobStore,
  ListJobsOptions,
  PipelineEvent,
} from '@autonome-research/thread-phase';

/** A v5.0.0-style custom store: no post-5.0 lifecycle capabilities. */
export class V5CustomJobStore implements JobStore {
  private nextJobId = 1;
  private nextEventId = 1;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly events: EventRecord[] = [];

  async createJob(name: string, input: unknown): Promise<string> {
    const id = `legacy-${this.nextJobId++}`;
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

  async appendEvent(jobId: string, event: PipelineEvent): Promise<number> {
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

const unchangedV5Store: JobStore = new V5CustomJobStore();
const status: JobStatus = 'RUNNING';
void unchangedV5Store;
void status;
