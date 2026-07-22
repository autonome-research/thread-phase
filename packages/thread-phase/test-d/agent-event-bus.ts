import {
  createEventBus,
  type AgentEvent,
  type AgentEventBus,
  type AgentEventHandler,
  type AgentEventPersistenceFailure,
  type ObservableAgentEventBus,
} from '@autonome-research/thread-phase/agents';

class LegacyEventBus implements AgentEventBus {
  emit(_event: AgentEvent): void {}

  on(_handler: AgentEventHandler): () => void {
    return () => {};
  }
}

const legacyBus: AgentEventBus = new LegacyEventBus();
const factoryBus: ObservableAgentEventBus = createEventBus();
const factoryBusAsLegacy: AgentEventBus = factoryBus;

factoryBus.onHandlerError(() => {});
legacyBus.emit({ type: 'text', source: 'legacy', delta: 'compatible' });
factoryBusAsLegacy.on(() => {});

declare const persistenceFailure: AgentEventPersistenceFailure;
// @ts-expect-error persistence notifications are immutable
persistenceFailure.kind = 'overflow';
// @ts-expect-error persistence notifications are immutable
persistenceFailure.event = { type: 'text', source: 'mutated', delta: 'nope' };
// @ts-expect-error persistence notifications are immutable
persistenceFailure.error = new Error('nope');
// @ts-expect-error persistence notifications are immutable
persistenceFailure.occurrences = 2;
