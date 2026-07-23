import {
  JobRunner,
  type CursorJobStore,
  type JobListCursor,
  type JobRunnerOptions,
  type JobStore,
  type ListJobsPageOptions,
  type LiveEventListenerFailure,
  type SqliteJobStore,
} from '@autonome-research/thread-phase';
import type {
  LiveEventListenerFailure as SessionLiveEventListenerFailure,
} from '@autonome-research/thread-phase/session';

declare const failure: LiveEventListenerFailure;
const sessionFailure: SessionLiveEventListenerFailure = failure;
void sessionFailure;

// @ts-expect-error live-listener failure notifications are immutable
failure.event = failure.event;
// @ts-expect-error live-listener failure notifications are immutable
failure.error = new Error('replacement');

const options: JobRunnerOptions = {
  onLiveEventError: async (reported) => {
    const eventType: string = reported.event.eventType;
    void eventType;
  },
};

declare const sqliteStore: SqliteJobStore;
const cursorStore: CursorJobStore = sqliteStore;
const cursor: JobListCursor = { createdAt: new Date(), id: 'job-id' };
const pageOptions: ListJobsPageOptions = { limit: 100, before: cursor };
void cursorStore.listJobsPage(pageOptions);

declare const baseStore: JobStore;
// @ts-expect-error the published-compatible base contract does not require cursor pagination
baseStore.listJobsPage();

void JobRunner;
void options;
