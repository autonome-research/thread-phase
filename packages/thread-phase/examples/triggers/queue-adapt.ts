/**
 * queue-adapt — adapt a message queue into the Trigger protocol.
 *
 * thread-phase doesn't ship queue clients. This is the recipe for
 * wrapping any queue consumer (Redis Streams, Kafka, RabbitMQ, SQS,
 * BullMQ, NATS) into a Trigger. The pattern:
 *
 *   1. Connect to your queue however its SDK wants.
 *   2. Inside Trigger.start(), poll/subscribe and yield TriggerEvents.
 *   3. ACK the message after the pipeline succeeds (via runTrigger's
 *      onComplete) or NACK on failure (via onError).
 *
 * The example uses an in-memory queue as a stand-in. Replace
 * InMemoryQueue with your real client.
 *
 * Run: npx tsx examples/triggers/queue-adapt.ts
 */

import {
  PipelineCache,
  type BasePipelineContext,
  type Phase,
} from '../../src/index.js';
import {
  runTrigger,
  type Trigger,
  type TriggerEvent,
} from '../../src/triggers/index.js';

// --- A fake queue you'd replace with redis/sqs/kafka/etc. -------------------

interface Message<T> {
  id: string;
  body: T;
}

class InMemoryQueue<T> {
  private messages: Message<T>[] = [];
  private wakeWaiters: Array<() => void> = [];

  enqueue(body: T): string {
    const id = `msg-${Math.random().toString(36).slice(2, 8)}`;
    this.messages.push({ id, body });
    this.wakeWaiters.forEach((w) => w());
    this.wakeWaiters = [];
    return id;
  }

  async dequeue(): Promise<Message<T>> {
    while (this.messages.length === 0) {
      await new Promise<void>((resolve) => this.wakeWaiters.push(resolve));
    }
    return this.messages.shift()!;
  }

  ack(id: string): void {
    console.log(`  [queue] ack ${id}`);
  }

  nack(id: string): void {
    console.log(`  [queue] nack ${id}`);
  }
}

// --- Trigger wrapper --------------------------------------------------------

interface Job {
  task: string;
  priority: 'low' | 'high';
}

class QueueTrigger implements Trigger<Job> {
  readonly name = 'queue';
  private seq = 0;
  private stopped = false;
  private currentMessageId: string | null = null;

  constructor(private readonly queue: InMemoryQueue<Job>) {}

  async *start(): AsyncGenerator<TriggerEvent<Job>, void> {
    while (!this.stopped) {
      const message = await this.queue.dequeue();
      if (this.stopped) return;

      this.currentMessageId = message.id;
      yield {
        id: ++this.seq,
        occurredAt: new Date().toISOString(),
        input: message.body,
        metadata: { messageId: message.id },
      };
    }
  }

  ack(messageId: string): void {
    this.queue.ack(messageId);
  }

  nack(messageId: string): void {
    this.queue.nack(messageId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Wake the dequeue so the generator can exit.
    this.queue.enqueue({ task: '__poison__', priority: 'low' });
  }
}

// --- pipeline ---------------------------------------------------------------

interface Ctx extends BasePipelineContext {
  job: Job;
  processed?: boolean;
}

const handleJob: Phase<Ctx> = {
  name: 'handle',
  async *run(ctx) {
    if (ctx.job.task === '__poison__') {
      // The stop-signal poison message; mark as processed without action.
      ctx.processed = true;
      yield { type: 'phase', phase: 'handle', detail: 'poison' };
      return;
    }
    yield {
      type: 'phase',
      phase: 'handle',
      detail: `processing ${ctx.job.priority} task: ${ctx.job.task}`,
    };
    ctx.processed = true;
  },
};

// --- wire it up -------------------------------------------------------------

const queue = new InMemoryQueue<Job>();
const trigger = new QueueTrigger(queue);

const handle = runTrigger(
  trigger,
  (job) => ({ phases: [handleJob], ctx: { cache: new PipelineCache(), job } }),
  {
    maxConcurrency: 3,
    onComplete: (event) => {
      const msgId = event.metadata?.messageId as string | undefined;
      if (msgId) trigger.ack(msgId);
    },
    onError: (event, err) => {
      const msgId = event.metadata?.messageId as string | undefined;
      if (msgId) trigger.nack(msgId);
      console.error(`[err] event ${event.id}: ${err.message}`);
    },
  },
);

// Push a few jobs.
queue.enqueue({ task: 'send-email', priority: 'low' });
queue.enqueue({ task: 'process-payment', priority: 'high' });
queue.enqueue({ task: 'index-document', priority: 'low' });

setTimeout(() => void handle.stop(), 200);
await handle.done;

console.log('\nDone — all jobs processed and ack-ed.');
