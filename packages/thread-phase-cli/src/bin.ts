#!/usr/bin/env node
/**
 * thread-phase bin entry.
 *
 * Tiny shim: parse argv, delegate to runCli, exit with its code.
 */

import { runCli } from './cli.js';

const code = await runCli({ args: process.argv.slice(2) });
process.exit(code);
