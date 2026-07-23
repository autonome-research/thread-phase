import { SqliteJobStore } from '../../src/session/sqlite-job-store.js';

let store: SqliteJobStore | undefined;

function send(message: Record<string, unknown>): void {
  if (!process.send) throw new Error('migration child requires an IPC channel');
  process.send(message);
}

process.on('message', (message: unknown) => {
  const command = message as { type?: string; dbPath?: string };
  if (command.type === 'start' && command.dbPath) {
    send({ type: 'opening' });
    try {
      store = new SqliteJobStore(command.dbPath);
      send({ type: 'result', ok: true });
    } catch (error: unknown) {
      send({
        type: 'result',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (command.type === 'close') {
    store?.close();
    store = undefined;
    send({ type: 'closed' });
    process.disconnect();
  }
});

send({ type: 'ready' });
