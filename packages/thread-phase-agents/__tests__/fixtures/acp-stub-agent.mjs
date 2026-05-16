#!/usr/bin/env node
// Minimal ACP-speaking agent stub for integration tests.
//
// Implements the ACP method surface our chassis exercises:
//   - initialize: returns a static handshake
//   - session/new: returns a fresh session id
//   - session/load: accepts a provided id without verification
//   - session/prompt: emits a couple of agent_message_chunk notifications
//     after a short delay, then resolves with stopReason 'end_turn'.
//     When the test wants an error path, prompt text 'force-error' makes
//     the stub return a JSON-RPC error.
//   - session/cancel: completes the in-flight prompt with stopReason
//     'cancelled' (per the ACP spec; cancel doesn't itself respond).
//
// Reads NDJSON from stdin, writes NDJSON to stdout. Silent on stderr
// unless explicitly logging.

import { createInterface } from 'node:readline';

const send = (msg) => {
  process.stdout.write(JSON.stringify(msg) + '\n');
};

let nextSessionId = 1;
const sessions = new Set();
const inFlight = new Map(); // sessionId -> requestId

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'acp-stub', version: '0.0.1' },
          agentCapabilities: { loadSession: true },
          authMethods: [],
        },
      });
      break;

    case 'session/new': {
      const sid = `stub-${nextSessionId++}`;
      sessions.add(sid);
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid } });
      break;
    }

    case 'session/load': {
      const sid = msg.params?.sessionId;
      if (sid) sessions.add(sid);
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      break;
    }

    case 'session/prompt': {
      const { sessionId, prompt } = msg.params || {};
      inFlight.set(sessionId, msg.id);
      const promptText = Array.isArray(prompt)
        ? prompt.map((b) => (b?.type === 'text' ? b.text : '')).join('')
        : '';

      if (promptText.includes('force-error')) {
        inFlight.delete(sessionId);
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'stub forced error' },
        });
        break;
      }

      // Defer the response so cancellation has time to interrupt during
      // the abort test. 50ms is plenty for the test to fire abort().
      setTimeout(() => {
        if (!inFlight.has(sessionId)) return; // cancelled before completion
        // Emit a few session/update notifications.
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello ' },
            },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'world.' },
            },
          },
        });
        const reqId = inFlight.get(sessionId);
        inFlight.delete(sessionId);
        send({
          jsonrpc: '2.0',
          id: reqId,
          result: { stopReason: 'end_turn' },
        });
      }, 50);
      break;
    }

    case 'session/cancel': {
      const sid = msg.params?.sessionId;
      const reqId = inFlight.get(sid);
      if (reqId !== undefined) {
        inFlight.delete(sid);
        send({
          jsonrpc: '2.0',
          id: reqId,
          result: { stopReason: 'cancelled' },
        });
      }
      break;
    }

    default:
      if (msg.id !== undefined) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `unknown method: ${msg.method}` },
        });
      }
      break;
  }
});

rl.on('close', () => {
  process.exit(0);
});
