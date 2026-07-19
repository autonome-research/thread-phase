import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Provenance {
  package: string;
  version: string;
  registryShasumSha1: string;
  registryIntegrity: string;
  tarballSha256: string;
  publishedDeclarationFileCount: number;
  publishedDeclarationManifest: string;
  publishedDeclarationManifestSha256: string;
  files: Record<string, string>;
}

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-d',
  'fixtures',
  'v5.0.0',
);

// Reviewed constants bind the mutable fixture metadata to the immutable npm
// tarball. Updating declarations and provenance.json alone must not pass.
const EXPECTED_MANIFEST_SHA256 = '41ac63a76b5fd8e71ae6c093053eff3e642ccad307528ff2fe781272076a28cb';
const EXPECTED_JOB_STORE_SHA256 = 'e58d76283c2abb050ba69bd7b9e24f9e46df083010692156cd74a938d6ea8a62';
const EXPECTED_PHASE_SHA256 = 'f6192fe243d40393e9e7c8e497f7f98e7f3ba382c0c60965829fd15f35bc36a3';

describe('published v5.0.0 API provenance', () => {
  it('retains byte-exact declaration artifacts with immutable registry identifiers', async () => {
    const provenance = JSON.parse(
      await readFile(join(fixtureDir, 'provenance.json'), 'utf8'),
    ) as Provenance;

    expect(provenance).toMatchObject({
      package: '@autonome-research/thread-phase',
      version: '5.0.0',
      registryShasumSha1: 'b65bef53d5d36726cb37b98b575108305aff9a4d',
      registryIntegrity: 'sha512-Utn4dMqH1GWZRAQQDbVy730M6jWHBpXl6YvmMXEASdZvoNPm7MZ+agGbLVa1xQwl3ombJ+8znpxgfg06B2bFdA==',
      tarballSha256: 'd559ebd7eb68f25781a4ad46ed02d484870093d07832ec4ad85aad0eb92cee90',
    });

    expect(Object.keys(provenance.files)).toContain('published/session/job-store.d.ts');
    expect(Object.keys(provenance.files)).toContain('published/phase.d.ts');

    expect(provenance.publishedDeclarationManifestSha256).toBe(EXPECTED_MANIFEST_SHA256);
    expect(provenance.files['published/session/job-store.d.ts']).toBe(EXPECTED_JOB_STORE_SHA256);
    expect(provenance.files['published/phase.d.ts']).toBe(EXPECTED_PHASE_SHA256);

    const manifestBytes = await readFile(join(fixtureDir, provenance.publishedDeclarationManifest));
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(EXPECTED_MANIFEST_SHA256);
    const manifestEntries = manifestBytes.toString('utf8').trim().split('\n');
    expect(manifestEntries).toHaveLength(provenance.publishedDeclarationFileCount);
    for (const entry of manifestEntries) {
      const match = /^([a-f0-9]{64})  (published\/.+)$/.exec(entry);
      expect(match, entry).not.toBeNull();
      const [, expectedSha256, relativePath] = match!;
      const bytes = await readFile(join(fixtureDir, relativePath));
      expect(createHash('sha256').update(bytes).digest('hex'), relativePath).toBe(expectedSha256);
    }

    for (const [relativePath, expectedSha256] of Object.entries(provenance.files)) {
      const bytes = await readFile(join(fixtureDir, relativePath));
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      expect(actualSha256, relativePath).toBe(expectedSha256);
    }
  });
});
