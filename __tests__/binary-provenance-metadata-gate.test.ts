import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkBinaryProvenanceMetadata } from '../scripts/dependency-provenance-compliance.mjs';

const tempDirs: string[] = [];

async function createFixture(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'binary-provenance-gate-'));
  tempDirs.push(repoRoot);

  await mkdir(path.join(repoRoot, 'lib'), { recursive: true });
  await writeFile(path.join(repoRoot, 'lib', 'vendor.js'), 'console.log("vendor");\n', 'utf8');

  const metadata = {
    version: 1,
    trackedBinaryPaths: ['lib/vendor.js'],
    entries: [
      {
        path: 'lib/vendor.js',
        sourceUrl: 'https://example.test/vendor.js',
        sourceRef: 'v1.2.3',
        expectedSha256: '35f374e3a47afe30809e09773adf5206b400ca86b667cc9aa5c5f953907475e7',
        retrievedOn: '2026-02-21',
        owner: 'security-maintainers',
        updateProcedure: [
          'Download upstream asset and verify release metadata.',
          'Update expectedSha256 and run pnpm binary-provenance:check.',
        ],
      },
    ],
  };

  await writeFile(
    path.join(repoRoot, 'lib', 'third-party-binary-provenance.json'),
    JSON.stringify(metadata, null, 2) + '\n',
    'utf8',
  );

  return repoRoot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('binary provenance metadata gate', () => {
  it('passes when metadata is valid and hashes match', async () => {
    const repoRoot = await createFixture();

    const result = await checkBinaryProvenanceMetadata({ repoRoot });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when tracked binary has no provenance entry', async () => {
    const repoRoot = await createFixture();
    await writeFile(
      path.join(repoRoot, 'lib', 'third-party-binary-provenance.json'),
      JSON.stringify(
        {
          version: 1,
          trackedBinaryPaths: ['lib/vendor.js'],
          entries: [],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const result = await checkBinaryProvenanceMetadata({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MISSING_PROVENANCE_ENTRY',
          path: 'lib/vendor.js',
        }),
      ]),
    );
  });

  it('fails when metadata schema is invalid', async () => {
    const repoRoot = await createFixture();
    await writeFile(
      path.join(repoRoot, 'lib', 'third-party-binary-provenance.json'),
      JSON.stringify(
        {
          version: 1,
          trackedBinaryPaths: ['lib/vendor.js'],
          entries: [
            {
              path: 'lib/vendor.js',
              sourceUrl: 'https://example.test/vendor.js',
              sourceRef: 'v1.2.3',
              expectedSha256: 'invalid',
              retrievedOn: '2026-02-21',
              owner: 'security-maintainers',
              updateProcedure: ['step'],
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const result = await checkBinaryProvenanceMetadata({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INVALID_PROVENANCE_SCHEMA',
        }),
      ]),
    );
  });

  it('fails when tracked binary path is missing from repository', async () => {
    const repoRoot = await createFixture();
    await unlink(path.join(repoRoot, 'lib', 'vendor.js'));

    const result = await checkBinaryProvenanceMetadata({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MISSING_TRACKED_BINARY',
          path: 'lib/vendor.js',
        }),
      ]),
    );
  });
});
