/**
 * Trigger extension — fires every 6 hours starting at startup.
 *
 * Pattern: drop this file into `.thread-phase/triggers/` to register
 * a Trigger by name. Pipelines reference it via `trigger: 'morning-timer'`.
 */

import { TimerTrigger } from '@autonome-research/thread-phase/triggers';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

export default (api: ThreadPhaseAPI) => {
  api.registerTrigger(
    'morning-timer',
    new TimerTrigger({
      intervalMs: 6 * 60 * 60 * 1000,
      fireImmediately: true,
      name: 'every-6h',
    }),
  );
};
