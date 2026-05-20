#!/usr/bin/env node
// Minimal Claude Code stream-json stub for integration tests.
//
// Emits a script of newline-delimited JSON messages mirroring the
// canonical Claude Code stream-json output:
//   {"type":"system","subtype":"init","session_id":"...","cwd":"..."}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
//   {"type":"result","subtype":"success","session_id":"...","result":"..."}
//
// Args: anything; the prompt is the last positional. If the prompt
// contains 'force-error', the stub exits with code 1 after emitting
// nothing useful. If it contains 'force-tool', the stub emits a
// tool_use block.

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

if (prompt.includes('force-error')) {
  process.stderr.write('stub: simulated error\n');
  process.exit(1);
}

const sessionId = 'stub-session-' + Math.random().toString(36).slice(2, 8);

setImmediate(() => {
  send({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    tools: [],
    model: 'stub-claude',
  });

  if (prompt.includes('force-tool')) {
    send({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_stub_1',
            name: 'echo',
            input: { text: 'hello' },
          },
        ],
      },
    });
    send({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_stub_1',
            content: 'hello',
            is_error: false,
          },
        ],
      },
    });
  }

  send({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Hello ' }],
    },
  });
  send({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'world.' }],
    },
  });
  send({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: 'Hello world.',
  });
  process.exit(0);
});
