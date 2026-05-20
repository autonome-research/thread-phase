import { TimerTrigger } from '@autonome-research/thread-phase/triggers';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

export default (api: ThreadPhaseAPI) => {
  api.registerTrigger('inside-folder', new TimerTrigger({ intervalMs: 100 }));
};
