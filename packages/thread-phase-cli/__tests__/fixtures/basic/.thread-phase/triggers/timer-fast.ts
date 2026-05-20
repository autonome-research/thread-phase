import { TimerTrigger } from '@autonome-research/thread-phase/triggers';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

export default (api: ThreadPhaseAPI) => {
  api.registerTrigger('timer-fast', new TimerTrigger({ intervalMs: 50 }));
};
