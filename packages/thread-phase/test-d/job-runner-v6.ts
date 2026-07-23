import {
  JobRunner,
  type JobRunnerOptions,
  type LiveEventListenerFailure,
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

void JobRunner;
void options;
