/**
 * `thread-phase init [name]` — scaffold a new project.
 *
 * Behavior:
 *   - No name → scaffold in cwd.
 *   - With name → `mkdir <name>/` (error if it exists), scaffold inside.
 *   - Refuses if `.thread-phase/` already exists at the target.
 *   - Always creates: `.thread-phase/{triggers,adapters,pipelines,lib}/` and
 *     a sample `pipelines/hello.ts` using `oneShot`.
 *   - Creates `package.json` if absent. Leaves existing package.json alone.
 *   - Prints a "next steps" line to stdout.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

const HELLO_TEMPLATE = `/**
 * Sample one-shot pipeline. Edit this — or delete it and write your own.
 *
 * Run with: thread-phase run hello
 */

import { oneShot } from '@autonome-research/thread-phase';

export default oneShot(async () => {
  console.log('hello from thread-phase');
  return { greeting: 'hello from thread-phase' };
});
`;

function makePackageJson(dirName: string, cliVersion: string): string {
  const sanitized =
    dirName
      .toLowerCase()
      .replace(/[^a-z0-9._~-]/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '') || 'thread-phase-project';

  return (
    JSON.stringify(
      {
        name: sanitized,
        private: true,
        type: 'module',
        dependencies: {
          // Both explicit. The CLI bundles thread-phase as a regular dep,
          // but listing thread-phase here too keeps `npm ls` honest and
          // makes the project's contract clear if the CLI is ever swapped.
          '@autonome-research/thread-phase': `^${cliVersion}`,
          '@autonome-research/thread-phase-cli': `^${cliVersion}`,
        },
      },
      null,
      2,
    ) + '\n'
  );
}

const LIB_README = `# .thread-phase/lib/

Shared user-side code (custom patterns, helpers, types) imported by registered
extensions via relative paths.

Files in this directory are **NOT auto-loaded** by the CLI. The loader only
scans \`.thread-phase/{triggers,adapters,pipelines}/\`. Use \`lib/\` for code that
two or more extensions import — promote inline helpers here once a second
caller appears.

Example:

\`\`\`
.thread-phase/
  lib/
    poll-until.ts          ← custom pattern wrapping whileCondition
  pipelines/
    poll-job.ts            ← imports { pollUntil } from '../lib/poll-until.js'
    poll-deployment.ts     ← imports the same helper
\`\`\`

See https://github.com/autonome-research/thread-phase/blob/master/EXTENDING.md for the full convention.
`;

export async function cmdInit(
  args: string[],
  io: {
    cwd: string;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    cliVersion: string;
  },
): Promise<number> {
  const name = args.find((a) => !a.startsWith('--'));

  // Resolve target dir.
  let target: string;
  let createdSubdir = false;
  if (name === undefined) {
    target = resolve(io.cwd);
  } else {
    target = isAbsolute(name) ? name : resolve(io.cwd, name);
    if (existsSync(target)) {
      io.stderr.write(
        `thread-phase init: target directory already exists: ${target}\n`,
      );
      return 1;
    }
    mkdirSync(target, { recursive: true });
    createdSubdir = true;
  }

  // Refuse if already initialized.
  const tpDir = join(target, '.thread-phase');
  if (existsSync(tpDir) && statSync(tpDir).isDirectory()) {
    io.stderr.write(
      `thread-phase init: ${target} is already initialized (.thread-phase/ exists). See EXTENDING.md to add more extensions.\n`,
    );
    return 1;
  }

  // Scaffold the four extension dirs.
  for (const kind of ['triggers', 'adapters', 'pipelines', 'lib']) {
    mkdirSync(join(tpDir, kind), { recursive: true });
  }

  // Sample pipeline.
  writeFileSync(join(tpDir, 'pipelines', 'hello.ts'), HELLO_TEMPLATE);

  // lib/ purpose-explainer so the empty dir isn't mysterious.
  writeFileSync(join(tpDir, 'lib', 'README.md'), LIB_README);

  // package.json if absent.
  const pkgPath = join(target, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      makePackageJson(basename(target), io.cliVersion),
    );
  }

  // Next steps.
  io.stdout.write(`thread-phase initialized at ${target}\n\nNext:\n`);
  if (createdSubdir && name !== undefined) {
    io.stdout.write(`  cd ${name}\n`);
  }
  io.stdout.write(`  npm install\n  thread-phase run hello\n`);

  return 0;
}
