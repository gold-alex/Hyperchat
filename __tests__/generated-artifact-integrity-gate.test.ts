import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyGeneratedArtifactIntegrity } from '../scripts/artifact-integrity.mjs';

const tempDirs: string[] = [];

async function createFixture(options: { generateOutput?: boolean } = {}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'generated-artifact-integrity-'));
  tempDirs.push(repoRoot);

  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
  await mkdir(path.join(repoRoot, 'lib'), { recursive: true });

  await writeFile(path.join(repoRoot, 'src', 'input.txt'), 'hello\n', 'utf8');
  await writeFile(
    path.join(repoRoot, 'scripts', 'generate.mjs'),
    [
      "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
      '',
      "const input = await readFile('src/input.txt', 'utf8');",
      "await mkdir('lib', { recursive: true });",
      "await writeFile('lib/generated.txt', `generated:${input.trim()}\\n`, 'utf8');",
      '',
    ].join('\n'),
    'utf8',
  );

  const manifest = {
    version: 1,
    verifyCommand: 'pnpm generated-artifacts:verify',
    regenerateCommand: 'pnpm generated-artifacts:regenerate',
    contracts: [
      {
        name: 'fixture-generated-artifact',
        inputs: ['src/input.txt', 'scripts/generate.mjs'],
        outputs: ['lib/generated.txt'],
        command: 'node scripts/generate.mjs',
      },
    ],
  };

  await writeFile(path.join(repoRoot, 'lib', 'generated-artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (options.generateOutput !== false) {
    await writeFile(path.join(repoRoot, 'lib', 'generated.txt'), 'generated:hello\n', 'utf8');
  }

  return repoRoot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('generated artifact integrity gate', () => {
  it('passes when committed generated output matches deterministic regeneration', async () => {
    const repoRoot = await createFixture();

    const result = await verifyGeneratedArtifactIntegrity({ repoRoot });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.checkedContracts).toBe(1);
  });

  it('fails when committed generated output drifts from regenerated output', async () => {
    const repoRoot = await createFixture();
    await writeFile(path.join(repoRoot, 'lib', 'generated.txt'), 'generated:drift\n', 'utf8');

    const result = await verifyGeneratedArtifactIntegrity({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'OUTPUT_DRIFT',
          contract: 'fixture-generated-artifact',
          path: 'lib/generated.txt',
        }),
      ]),
    );
  });

  it('fails when a committed generated output is missing', async () => {
    const repoRoot = await createFixture();
    await unlink(path.join(repoRoot, 'lib', 'generated.txt'));

    const result = await verifyGeneratedArtifactIntegrity({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MISSING_COMMITTED_OUTPUT',
          contract: 'fixture-generated-artifact',
          path: 'lib/generated.txt',
        }),
      ]),
    );
  });

  it('fails with deterministic manifest error on malformed contract definition', async () => {
    const repoRoot = await createFixture({ generateOutput: false });
    const malformedManifest = {
      version: 1,
      contracts: [
        {
          name: 'broken-contract',
          inputs: ['src/input.txt'],
          outputs: [],
          command: 'node scripts/generate.mjs',
        },
      ],
    };

    await writeFile(
      path.join(repoRoot, 'lib', 'generated-artifact-manifest.json'),
      `${JSON.stringify(malformedManifest, null, 2)}\n`,
      'utf8',
    );

    const result = await verifyGeneratedArtifactIntegrity({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INVALID_MANIFEST',
          path: 'lib/generated-artifact-manifest.json',
        }),
      ]),
    );
  });
});
