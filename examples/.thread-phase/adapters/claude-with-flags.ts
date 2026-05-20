/**
 * Adapter extension — re-exports claudeCodeAgent with project-specific
 * defaults under a stable name.
 *
 * Pattern: when you want one or more pipelines to share a specific
 * adapter configuration (model, tools, flags), wrap the base adapter
 * and register it by name. Pipelines look it up via the registry.
 */

import { defineAgentAdapter } from '@autonome-research/thread-phase/agents';
import { claudeCodeAgent } from '@autonome-research/thread-phase-agents';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

export default (api: ThreadPhaseAPI) => {
  // claudeCodeAgent's adapter shape stays the same; the "with-flags"
  // version is a thin wrapper that defaults extra config every call.
  const adapter = defineAgentAdapter({
    id: 'claude-with-flags',
    capabilities: claudeCodeAgent.capabilities,
    adapter: (config, options) =>
      claudeCodeAgent.adapter(
        {
          ...config,
          extraArgs: ['--permission-mode', 'plan'],
        } as Parameters<typeof claudeCodeAgent.adapter>[0],
        options,
      ),
  });

  api.registerAdapter('claude-with-flags', adapter);
};
