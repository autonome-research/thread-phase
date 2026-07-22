import { SqliteJobStore } from '../../src/session/sqlite-job-store.js';

let store: SqliteJobStore | undefined;

function send(message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('acquisition child requires an IPC channel'));
      return;
    }
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

process.on('message', async (message: unknown) => {
  const command = message as {
    type?: string;
    dbPath?: string;
    name?: string;
    input?: unknown;
  };

  if (command.type === 'open' && command.dbPath) {
    try {
      store = new SqliteJobStore(command.dbPath);
      await send({ type: 'opened' });
    } catch (error: unknown) {
      await send({
        type: 'opened',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (command.type === 'acquire' && store && command.name) {
    // Await IPC delivery before entering synchronous SQLite work. The parent
    // can therefore prove every contender reached the explicit start barrier.
    await send({ type: 'acquiring' });
    try {
      const jobId = await store.acquireExclusive(command.name, command.input);
      await send({ type: 'result', ok: true, jobId });
    } catch (error: unknown) {
      await send({
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
    await send({ type: 'closed' });
    process.disconnect();
  }
});

await send({ type: 'ready' });
