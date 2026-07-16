import {
  createEventBus,
  type AgentEvent,
  type AgentEventBus,
  type AgentEventHandler,
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
