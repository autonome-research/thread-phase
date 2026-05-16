/**
 * Test utilities for the AgentAdapter protocol.
 *
 * Importers (in-tree tests and the sibling `thread-phase-agents` package)
 * pull `createMockAgent` for scripted adapter behavior and
 * `runAdapterConformance` for protocol-contract assertions.
 *
 * @internal
 */

export {
  createMockAgent,
  MOCK_DEFAULT_CAPABILITIES,
  type CreateMockAgentOptions,
  type MockAgentConfig,
} from './mock-agent.js';

export {
  runAdapterConformance,
  type ConformanceConfigBuilder,
  type RunConformanceSuiteOptions,
} from './conformance.js';
