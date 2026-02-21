import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  verifyRuntimeArtifactHashes,
  writeManifest,
} from '../scripts/artifact-integrity.mjs';

const tempDirs: string[] = [];

async function createFixture(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'runtime-artifact-hash-'));
  tempDirs.push(repoRoot);
  const libDir = path.join(repoRoot, 'lib');
  await mkdir(libDir, { recursive: true });
  await writeFile(path.join(libDir, 'a.js'), 'console.log("a");\n', 'utf8');
  await writeFile(path.join(libDir, 'b.js'), 'console.log("b");\n', 'utf8');
  return repoRoot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runtime artifact hash manifest gate', () => {
  it('passes when tracked artifacts match the manifest', async () => {
    const repoRoot = await createFixture();
    await writeManifest({ repoRoot });

    const result = await verifyRuntimeArtifactHashes({ repoRoot });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.checkedEntries).toBe(2);
    expect(result.trackedArtifacts).toBe(2);
  });

  it('fails when a tracked artifact hash drifts', async () => {
    const repoRoot = await createFixture();
    await writeManifest({ repoRoot });
    await writeFile(path.join(repoRoot, 'lib', 'a.js'), 'console.log("a drift");\n', 'utf8');

    const result = await verifyRuntimeArtifactHashes({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'HASH_MISMATCH',
          path: 'lib/a.js',
        }),
      ]),
    );
  });

  it('fails when a manifest-tracked file is missing', async () => {
    const repoRoot = await createFixture();
    await writeManifest({ repoRoot });
    await unlink(path.join(repoRoot, 'lib', 'b.js'));

    const result = await verifyRuntimeArtifactHashes({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MISSING_TRACKED_FILE',
          path: 'lib/b.js',
        }),
      ]),
    );
  });
});
