import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// Runtime hash manifest gate constants
const LIB_DIR_RELATIVE = 'lib';
const RUNTIME_MANIFEST_RELATIVE_PATH = path.posix.join(LIB_DIR_RELATIVE, 'runtime-artifact-hashes.json');
const RUNTIME_REFRESH_COMMAND = 'pnpm runtime-artifacts:hash:update';
const RUNTIME_VERIFY_COMMAND = 'pnpm runtime-artifacts:hash:verify';

// Generated artifact gate constants
const GENERATED_MANIFEST_RELATIVE_PATH = path.posix.join('lib', 'generated-artifact-manifest.json');
const GENERATED_VERIFY_COMMAND = 'pnpm generated-artifacts:verify';
const GENERATED_REGENERATE_COMMAND = 'pnpm generated-artifacts:regenerate';
const COPY_EXCLUDES = new Set(['.git', 'node_modules', '.output', '.wxt', 'dist', 'coverage']);

function normalizeRelativePath(inputPath) {
  return String(inputPath).replace(/\\/g, '/');
}

function toAbsolutePath(repoRoot, relativePath) {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return path.join(repoRoot, ...normalizeRelativePath(relativePath).split('/'));
}

async function pathExists(absolutePath) {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function createError(code, contract, targetPath, message) {
  return {
    code,
    contract,
    path: targetPath,
    message,
  };
}

async function runShellCommand(command, cwd) {
  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        CI: '1',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

// Runtime hash manifest functions
export async function discoverTrackedRuntimeArtifacts(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const libDir = toAbsolutePath(repoRoot, LIB_DIR_RELATIVE);
  const entries = await readdir(libDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.js'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.posix.join(LIB_DIR_RELATIVE, name));
}

export async function sha256File(options) {
  const absolutePath = toAbsolutePath(options.repoRoot ?? DEFAULT_REPO_ROOT, options.filePath);
  const fileBytes = await readFile(absolutePath);
  return createHash('sha256').update(fileBytes).digest('hex');
}

export async function buildManifestEntries(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const trackedPaths = await discoverTrackedRuntimeArtifacts({ repoRoot });
  const entries = [];

  for (const trackedPath of trackedPaths) {
    const sha256 = await sha256File({ repoRoot, filePath: trackedPath });
    entries.push({ path: trackedPath, sha256 });
  }

  return entries;
}

function createRuntimeManifestPayload(entries) {
  return {
    version: 1,
    algorithm: 'sha256',
    trackedPattern: 'lib/*.js',
    refreshCommand: RUNTIME_REFRESH_COMMAND,
    verifyCommand: RUNTIME_VERIFY_COMMAND,
    entries,
  };
}

export async function writeManifest(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const entries = options.entries ?? await buildManifestEntries({ repoRoot });
  const manifestAbsolutePath = toAbsolutePath(repoRoot, RUNTIME_MANIFEST_RELATIVE_PATH);
  const manifestPayload = createRuntimeManifestPayload(entries);

  await mkdir(path.dirname(manifestAbsolutePath), { recursive: true });
  await writeFile(manifestAbsolutePath, `${JSON.stringify(manifestPayload, null, 2)}\n`, 'utf8');

  return {
    manifestPath: RUNTIME_MANIFEST_RELATIVE_PATH,
    entries,
  };
}

async function loadRuntimeManifest(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const manifestAbsolutePath = toAbsolutePath(repoRoot, RUNTIME_MANIFEST_RELATIVE_PATH);
  const raw = await readFile(manifestAbsolutePath, 'utf8');
  const manifest = JSON.parse(raw);

  if (!manifest || !Array.isArray(manifest.entries)) {
    throw new Error('Invalid manifest format: expected object with entries array');
  }

  return manifest;
}

export async function verifyRuntimeArtifactHashes(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const manifest = await loadRuntimeManifest({ repoRoot });
  const manifestEntries = manifest.entries.map((entry) => ({
    path: normalizeRelativePath(entry.path),
    sha256: String(entry.sha256 ?? '').toLowerCase(),
  }));
  const manifestEntryMap = new Map(manifestEntries.map((entry) => [entry.path, entry.sha256]));
  const trackedPaths = await discoverTrackedRuntimeArtifacts({ repoRoot });
  const trackedPathSet = new Set(trackedPaths);
  const errors = [];

  for (const trackedPath of trackedPaths) {
    if (!manifestEntryMap.has(trackedPath)) {
      errors.push({
        code: 'UNTRACKED_RUNTIME_ARTIFACT',
        path: trackedPath,
        message: `Runtime artifact is not listed in manifest: ${trackedPath}`,
      });
    }
  }

  for (const manifestEntry of manifestEntries) {
    const absolutePath = toAbsolutePath(repoRoot, manifestEntry.path);
    const exists = await pathExists(absolutePath);

    if (!exists) {
      errors.push({
        code: 'MISSING_TRACKED_FILE',
        path: manifestEntry.path,
        message: `Manifest entry points to missing file: ${manifestEntry.path}`,
      });
      continue;
    }

    if (!trackedPathSet.has(manifestEntry.path)) {
      errors.push({
        code: 'MANIFEST_ENTRY_OUT_OF_SCOPE',
        path: manifestEntry.path,
        message: `Manifest entry is outside tracked runtime artifact policy (lib/*.js): ${manifestEntry.path}`,
      });
      continue;
    }

    const actualHash = await sha256File({ repoRoot, filePath: manifestEntry.path });
    if (actualHash !== manifestEntry.sha256) {
      errors.push({
        code: 'HASH_MISMATCH',
        path: manifestEntry.path,
        message: `Hash mismatch for ${manifestEntry.path}: expected ${manifestEntry.sha256}, got ${actualHash}`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    checkedEntries: manifestEntries.length,
    trackedArtifacts: trackedPaths.length,
    errors,
    refreshCommand: manifest.refreshCommand || RUNTIME_REFRESH_COMMAND,
  };
}

// Generated artifact integrity functions
function ensureRelativePath(value, fieldName) {
  const normalized = normalizeRelativePath(value);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error(`${fieldName} must be a non-empty repository-relative path`);
  }
  return normalized;
}

function validateGeneratedManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('INVALID_MANIFEST: expected object');
  }
  if (!Array.isArray(manifest.contracts)) {
    throw new Error('INVALID_MANIFEST: expected contracts array');
  }

  const seenNames = new Set();
  for (const contract of manifest.contracts) {
    if (!contract || typeof contract !== 'object') {
      throw new Error('INVALID_MANIFEST_CONTRACT: each contract must be an object');
    }

    if (typeof contract.name !== 'string' || !contract.name.trim()) {
      throw new Error('INVALID_MANIFEST_CONTRACT: contract.name must be a non-empty string');
    }
    if (seenNames.has(contract.name)) {
      throw new Error(`INVALID_MANIFEST_CONTRACT: duplicate contract name '${contract.name}'`);
    }
    seenNames.add(contract.name);

    if (typeof contract.command !== 'string' || !contract.command.trim()) {
      throw new Error(`INVALID_MANIFEST_CONTRACT: contract '${contract.name}' must include a non-empty command`);
    }

    if (!Array.isArray(contract.outputs) || contract.outputs.length === 0) {
      throw new Error(`INVALID_MANIFEST_CONTRACT: contract '${contract.name}' must include at least one output path`);
    }

    if (!Array.isArray(contract.inputs) || contract.inputs.length === 0) {
      throw new Error(`INVALID_MANIFEST_CONTRACT: contract '${contract.name}' must include at least one input path`);
    }

    contract.outputs = contract.outputs.map((outputPath) => ensureRelativePath(outputPath, `contract '${contract.name}' output`));
    contract.inputs = contract.inputs.map((inputPath) => ensureRelativePath(inputPath, `contract '${contract.name}' input`));
  }

  return manifest;
}

async function loadGeneratedArtifactManifest(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const rawManifest = await readFile(toAbsolutePath(repoRoot, GENERATED_MANIFEST_RELATIVE_PATH), 'utf8');
  const manifest = JSON.parse(rawManifest);
  return validateGeneratedManifest(manifest);
}

async function createVerificationWorkspace(repoRoot) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'generated-artifact-verify-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');

  await cp(repoRoot, workspaceRoot, {
    recursive: true,
    filter: (sourcePath) => {
      const relativePath = path.relative(repoRoot, sourcePath);
      if (!relativePath) {
        return true;
      }
      const topLevel = normalizeRelativePath(relativePath).split('/')[0];
      return !COPY_EXCLUDES.has(topLevel);
    },
  });

  const sourceNodeModules = path.join(repoRoot, 'node_modules');
  const workspaceNodeModules = path.join(workspaceRoot, 'node_modules');
  if (await pathExists(sourceNodeModules)) {
    await symlink(sourceNodeModules, workspaceNodeModules, 'dir');
  }

  return {
    tempRoot,
    workspaceRoot,
  };
}

export async function verifyGeneratedArtifactIntegrity(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const errors = [];
  let manifest;

  try {
    manifest = await loadGeneratedArtifactManifest({ repoRoot });
  } catch (error) {
    return {
      ok: false,
      checkedContracts: 0,
      errors: [
        createError(
          'INVALID_MANIFEST',
          'manifest',
          GENERATED_MANIFEST_RELATIVE_PATH,
          error instanceof Error ? error.message : String(error),
        ),
      ],
      verifyCommand: GENERATED_VERIFY_COMMAND,
      regenerateCommand: GENERATED_REGENERATE_COMMAND,
    };
  }

  for (const contract of manifest.contracts) {
    for (const inputPath of contract.inputs) {
      const absoluteInputPath = toAbsolutePath(repoRoot, inputPath);
      if (!(await pathExists(absoluteInputPath))) {
        errors.push(
          createError(
            'MISSING_INPUT',
            contract.name,
            inputPath,
            `Input required by contract '${contract.name}' is missing: ${inputPath}`,
          ),
        );
      }
    }

    if (errors.some((entry) => entry.contract === contract.name && entry.code === 'MISSING_INPUT')) {
      continue;
    }

    const { tempRoot, workspaceRoot } = await createVerificationWorkspace(repoRoot);
    try {
      const commandResult = await runShellCommand(contract.command, workspaceRoot);
      if (commandResult.code !== 0) {
        const stderr = commandResult.stderr.trim();
        const stdout = commandResult.stdout.trim();
        const detail = stderr || stdout || 'No command output captured.';
        errors.push(
          createError(
            'COMMAND_FAILED',
            contract.name,
            '.',
            `Regeneration command failed for contract '${contract.name}' (exit ${commandResult.code}): ${detail}`,
          ),
        );
        continue;
      }

      for (const outputPath of contract.outputs) {
        const committedOutputPath = toAbsolutePath(repoRoot, outputPath);
        const regeneratedOutputPath = toAbsolutePath(workspaceRoot, outputPath);

        const committedExists = await pathExists(committedOutputPath);
        if (!committedExists) {
          errors.push(
            createError(
              'MISSING_COMMITTED_OUTPUT',
              contract.name,
              outputPath,
              `Committed output is missing for contract '${contract.name}': ${outputPath}`,
            ),
          );
          continue;
        }

        const regeneratedExists = await pathExists(regeneratedOutputPath);
        if (!regeneratedExists) {
          errors.push(
            createError(
              'MISSING_REGENERATED_OUTPUT',
              contract.name,
              outputPath,
              `Regeneration did not produce expected output for contract '${contract.name}': ${outputPath}`,
            ),
          );
          continue;
        }

        const committedBytes = await readFile(committedOutputPath);
        const regeneratedBytes = await readFile(regeneratedOutputPath);
        if (!committedBytes.equals(regeneratedBytes)) {
          errors.push(
            createError(
              'OUTPUT_DRIFT',
              contract.name,
              outputPath,
              `Regenerated output drift detected for contract '${contract.name}': ${outputPath}`,
            ),
          );
        }
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  return {
    ok: errors.length === 0,
    checkedContracts: manifest.contracts.length,
    errors,
    verifyCommand: manifest.verifyCommand || GENERATED_VERIFY_COMMAND,
    regenerateCommand: manifest.regenerateCommand || GENERATED_REGENERATE_COMMAND,
  };
}

export async function regenerateGeneratedArtifacts(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const manifest = await loadGeneratedArtifactManifest({ repoRoot });
  const failures = [];

  for (const contract of manifest.contracts) {
    const commandResult = await runShellCommand(contract.command, repoRoot);
    if (commandResult.code !== 0) {
      const stderr = commandResult.stderr.trim();
      const stdout = commandResult.stdout.trim();
      const detail = stderr || stdout || 'No command output captured.';
      failures.push(
        createError(
          'COMMAND_FAILED',
          contract.name,
          '.',
          `Regeneration command failed for contract '${contract.name}' (exit ${commandResult.code}): ${detail}`,
        ),
      );
    }
  }

  return {
    ok: failures.length === 0,
    regeneratedContracts: manifest.contracts.length - failures.length,
    failures,
  };
}

function printArtifactIntegrityUsage() {
  console.error('Usage: node scripts/artifact-integrity.mjs <runtime-hash|generated> <verify|update|regenerate>');
}

async function runCli() {
  const [group, action] = process.argv.slice(2);

  if (group === 'runtime-hash' && action === 'verify') {
    const result = await verifyRuntimeArtifactHashes();
    if (result.ok) {
      console.log(
        `Runtime artifact hash verification passed (${result.checkedEntries} manifest entries, ${result.trackedArtifacts} tracked artifacts).`,
      );
      return;
    }

    console.error('Runtime artifact hash verification failed.');
    for (const error of result.errors) {
      console.error(`- [${error.code}] ${error.path}`);
      console.error(`  ${error.message}`);
    }
    console.error(`Remediation: run \`${result.refreshCommand}\` if artifact changes are intentional, then rerun \`${RUNTIME_VERIFY_COMMAND}\`.`);
    process.exitCode = 1;
    return;
  }

  if (group === 'runtime-hash' && action === 'update') {
    const result = await writeManifest();
    console.log(`Updated ${result.manifestPath} with ${result.entries.length} runtime artifact hashes.`);
    console.log(`Next: run \`${RUNTIME_VERIFY_COMMAND}\` to confirm.`);
    return;
  }

  if (group === 'generated' && action === 'verify') {
    const result = await verifyGeneratedArtifactIntegrity();
    if (result.ok) {
      console.log(`Generated artifact integrity verification passed (${result.checkedContracts} contracts checked).`);
      return;
    }

    console.error('Generated artifact integrity verification failed.');
    for (const error of result.errors) {
      console.error(`- [${error.code}] (${error.contract}) ${error.path}`);
      console.error(`  ${error.message}`);
    }
    console.error(`Remediation: run \`${result.regenerateCommand}\` if changes are intentional, then rerun \`${GENERATED_VERIFY_COMMAND}\`.`);
    process.exitCode = 1;
    return;
  }

  if (group === 'generated' && action === 'regenerate') {
    const result = await regenerateGeneratedArtifacts();
    if (!result.ok) {
      console.error('Generated artifact regeneration failed.');
      for (const failure of result.failures) {
        console.error(`- [${failure.code}] (${failure.contract}) ${failure.path}`);
        console.error(`  ${failure.message}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`Regenerated ${result.regeneratedContracts} generated artifact contract(s).`);
    console.log(`Next: run \`${GENERATED_VERIFY_COMMAND}\` to confirm deterministic outputs.`);
    return;
  }

  printArtifactIntegrityUsage();
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error('Artifact integrity command failed with an unexpected error.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
