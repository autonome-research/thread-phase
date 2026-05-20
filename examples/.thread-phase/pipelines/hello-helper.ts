/**
 * The simplest possible registered pipeline, via the `oneShot` convenience
 * helper. One function, no Phase boilerplate.
 *
 * Compare with examples/.thread-phase/pipelines/minimal.ts which constructs
 * the Phase explicitly. Same end behavior; this version is ~5 lines.
 *
 * Run: thread-phase run hello-helper
 */

import { oneShot } from '@autonome-research/thread-phase';

export default oneShot(
  async () => {
    return { greeting: 'hello from oneShot' };
  },
  {
    name: 'hello-helper',
    description: 'minimal one-shot via the oneShot helper',
  },
);
