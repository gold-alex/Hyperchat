import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const DEFAULT_POLICY_RELATIVE_PATH = 'security/dependency-vulnerability-policy.json';
const DEFAULT_EXCEPTIONS_RELATIVE_PATH = 'security/dependency-vulnerability-exceptions.json';
const DEFAULT_METADATA_RELATIVE_PATH = 'lib/third-party-binary-provenance.json';

const DEPENDENCY_CHECK_COMMAND = 'node scripts/dependency-provenance-compliance.mjs dependency check';
const PROVENANCE_CHECK_COMMAND = 'node scripts/dependency-provenance-compliance.mjs provenance check';

const SEVERITY_RANK = {
  low: 1,
  medium: 2,
  moderate: 2,
  high: 3,
  critical: 4,
};

function normalizePath(value) {
  return String(value).replace(/\\/g, '/');
}

function toAbsolutePath(repoRoot, relativePath) {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return path.join(repoRoot, ...normalizePath(relativePath).split('/'));
}

function createError(code, message, context = {}) {
  return {
    code,
    message,
    ...context,
  };
}

async function pathExists(absolutePath) {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeSeverity(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized === 'moderate' ? 'medium' : normalized;
}

function parseJsonWithFallbacks(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate || (!candidate.startsWith('{') && !candidate.startsWith('['))) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function ensureIsoDate(dateValue, fieldName) {
  if (typeof dateValue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    throw new Error(`${fieldName} must be in YYYY-MM-DD format`);
  }
  const parsedDate = new Date(`${dateValue}T23:59:59.999Z`);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error(`${fieldName} must be a valid calendar date`);
  }
  return parsedDate;
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

// Dependency policy functions
export async function loadDependencyPolicy(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const policyPath = options.policyPath ?? DEFAULT_POLICY_RELATIVE_PATH;
  const raw = await readFile(toAbsolutePath(repoRoot, policyPath), 'utf8');
  const policy = JSON.parse(raw);

  if (!policy || typeof policy !== 'object') {
    throw new Error('policy must be an object');
  }
  if (typeof policy.auditCommand !== 'string' || !policy.auditCommand.trim()) {
    throw new Error('policy.auditCommand must be a non-empty string');
  }

  const minimumSeverity = normalizeSeverity(policy.minimumSeverity);
  if (!SEVERITY_RANK[minimumSeverity]) {
    throw new Error('policy.minimumSeverity must be one of low|medium|high|critical');
  }

  return {
    version: policy.version ?? 1,
    auditCommand: policy.auditCommand,
    minimumSeverity,
    policyPath,
  };
}

export async function loadDependencyExceptions(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const exceptionsPath = options.exceptionsPath ?? DEFAULT_EXCEPTIONS_RELATIVE_PATH;
  const raw = await readFile(toAbsolutePath(repoRoot, exceptionsPath), 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.exceptions)) {
    throw new Error('exceptions file must contain an exceptions array');
  }

  const exceptions = parsed.exceptions.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`exceptions[${index}] must be an object`);
    }

    const advisoryId = String(entry.advisoryId ?? '').trim();
    const packageName = String(entry.package ?? '').trim();
    const owner = String(entry.owner ?? '').trim();
    const rationale = String(entry.rationale ?? '').trim();
    const expiresOn = String(entry.expiresOn ?? '').trim();

    if (!advisoryId) {
      throw new Error(`exceptions[${index}].advisoryId is required`);
    }
    if (!packageName) {
      throw new Error(`exceptions[${index}].package is required`);
    }
    if (!owner) {
      throw new Error(`exceptions[${index}].owner is required`);
    }
    if (!rationale) {
      throw new Error(`exceptions[${index}].rationale is required`);
    }

    const expiresAt = ensureIsoDate(expiresOn, `exceptions[${index}].expiresOn`);

    return {
      advisoryId,
      package: packageName,
      owner,
      rationale,
      expiresOn,
      expiresAt,
    };
  });

  return {
    version: parsed.version ?? 1,
    exceptions,
    exceptionsPath,
  };
}

export function extractDependencyFindings(report) {
  const findings = [];
  const seen = new Set();

  const pushFinding = (entry) => {
    const severity = normalizeSeverity(entry.severity);
    if (!SEVERITY_RANK[severity]) {
      return;
    }

    const advisoryId = String(entry.advisoryId ?? '').trim();
    const packageName = String(entry.package ?? '').trim();
    if (!advisoryId || !packageName) {
      return;
    }

    const key = `${advisoryId}|${packageName}|${severity}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    findings.push({
      advisoryId,
      package: packageName,
      severity,
      url: entry.url ? String(entry.url) : undefined,
    });
  };

  if (report && typeof report === 'object') {
    if (report.advisories && typeof report.advisories === 'object') {
      for (const [advisoryKey, advisory] of Object.entries(report.advisories)) {
        if (!advisory || typeof advisory !== 'object') {
          continue;
        }
        pushFinding({
          advisoryId: advisory.id ?? advisoryKey,
          package: advisory.module_name ?? advisory.name,
          severity: advisory.severity,
          url: advisory.url,
        });
      }
    }

    if (report.vulnerabilities && typeof report.vulnerabilities === 'object') {
      for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities)) {
        if (!vulnerability || typeof vulnerability !== 'object') {
          continue;
        }

        let pushedVia = false;
        const viaList = Array.isArray(vulnerability.via) ? vulnerability.via : [];
        for (const via of viaList) {
          if (!via || typeof via !== 'object') {
            continue;
          }

          const advisoryId = via.source ?? via.id ?? `${packageName}:${via.title ?? vulnerability.severity ?? 'unknown'}`;
          const severity = via.severity ?? vulnerability.severity;
          pushFinding({
            advisoryId,
            package: packageName,
            severity,
            url: via.url,
          });
          pushedVia = true;
        }

        if (!pushedVia) {
          pushFinding({
            advisoryId: vulnerability.id ?? `${packageName}:${vulnerability.severity ?? 'unknown'}`,
            package: packageName,
            severity: vulnerability.severity,
            url: vulnerability.url,
          });
        }
      }
    }
  }

  return findings;
}

function severityMeetsThreshold(severity, minimumSeverity) {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimumSeverity];
}

export async function runDependencyPolicyCheck(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const now = options.now ?? new Date();

  let policy;
  let exceptionData;
  try {
    policy = await loadDependencyPolicy({
      repoRoot,
      policyPath: options.policyPath,
    });
  } catch (error) {
    return {
      ok: false,
      findings: [],
      violations: [],
      suppressions: [],
      errors: [
        createError('INVALID_POLICY_CONFIG', error instanceof Error ? error.message : String(error), {
          path: options.policyPath ?? DEFAULT_POLICY_RELATIVE_PATH,
        }),
      ],
      remediation: {
        localCheck: DEPENDENCY_CHECK_COMMAND,
      },
    };
  }

  try {
    exceptionData = await loadDependencyExceptions({
      repoRoot,
      exceptionsPath: options.exceptionsPath,
    });
  } catch (error) {
    return {
      ok: false,
      findings: [],
      violations: [],
      suppressions: [],
      errors: [
        createError('INVALID_EXCEPTION_SCHEMA', error instanceof Error ? error.message : String(error), {
          path: options.exceptionsPath ?? DEFAULT_EXCEPTIONS_RELATIVE_PATH,
        }),
      ],
      remediation: {
        localCheck: DEPENDENCY_CHECK_COMMAND,
        exceptionsFile: options.exceptionsPath ?? DEFAULT_EXCEPTIONS_RELATIVE_PATH,
      },
    };
  }

  let report = options.reportData;
  const errors = [];

  if (!report) {
    if (options.reportFile) {
      try {
        const reportRaw = await readFile(toAbsolutePath(repoRoot, options.reportFile), 'utf8');
        report = JSON.parse(reportRaw);
      } catch (error) {
        errors.push(createError('AUDIT_REPORT_PARSE_FAILED', error instanceof Error ? error.message : String(error), {
          path: options.reportFile,
        }));
      }
    } else {
      const commandResult = await runShellCommand(policy.auditCommand, repoRoot);
      const parsed = parseJsonWithFallbacks(commandResult.stdout) ?? parseJsonWithFallbacks(commandResult.stderr);
      if (!parsed) {
        errors.push(
          createError(
            'AUDIT_REPORT_PARSE_FAILED',
            `Unable to parse JSON report from audit command output (exit ${commandResult.code}).`,
            { command: policy.auditCommand },
          ),
        );
      } else {
        report = parsed;
      }

      if (commandResult.code !== 0 && !report) {
        errors.push(
          createError(
            'AUDIT_COMMAND_FAILED',
            `Audit command failed with exit code ${commandResult.code}.`,
            { command: policy.auditCommand },
          ),
        );
      }
    }
  }

  if (!report) {
    return {
      ok: false,
      findings: [],
      violations: [],
      suppressions: [],
      errors,
      remediation: {
        localCheck: DEPENDENCY_CHECK_COMMAND,
        auditCommand: policy.auditCommand,
        exceptionsFile: exceptionData.exceptionsPath,
      },
    };
  }

  const findings = extractDependencyFindings(report).filter((finding) =>
    severityMeetsThreshold(finding.severity, policy.minimumSeverity),
  );

  const exceptionsByKey = new Map(
    exceptionData.exceptions.map((entry) => [`${entry.advisoryId}|${entry.package}`, entry]),
  );
  const usedExceptionKeys = new Set();
  const violations = [];
  const suppressions = [];

  for (const finding of findings) {
    const key = `${finding.advisoryId}|${finding.package}`;
    const matchingException = exceptionsByKey.get(key);

    if (!matchingException) {
      violations.push(
        createError(
          'DEPENDENCY_VULNERABILITY_THRESHOLD_BREACH',
          `Unexcepted ${finding.severity} finding for ${finding.package} (${finding.advisoryId}).`,
          finding,
        ),
      );
      continue;
    }

    usedExceptionKeys.add(key);

    if (matchingException.expiresAt.getTime() < now.getTime()) {
      errors.push(
        createError(
          'EXCEPTION_EXPIRED',
          `Exception for ${finding.package} (${finding.advisoryId}) expired on ${matchingException.expiresOn}.`,
          {
            advisoryId: finding.advisoryId,
            package: finding.package,
            expiresOn: matchingException.expiresOn,
          },
        ),
      );
      violations.push(
        createError(
          'DEPENDENCY_VULNERABILITY_THRESHOLD_BREACH',
          `Expired exception does not suppress ${finding.package} (${finding.advisoryId}).`,
          finding,
        ),
      );
      continue;
    }

    suppressions.push({
      advisoryId: finding.advisoryId,
      package: finding.package,
      severity: finding.severity,
      owner: matchingException.owner,
      expiresOn: matchingException.expiresOn,
    });
  }

  for (const [key, exceptionEntry] of exceptionsByKey.entries()) {
    if (!usedExceptionKeys.has(key) && exceptionEntry.expiresAt.getTime() >= now.getTime()) {
      errors.push(
        createError(
          'EXCEPTION_UNUSED',
          `Active exception does not match any current finding: ${exceptionEntry.package} (${exceptionEntry.advisoryId}).`,
          {
            advisoryId: exceptionEntry.advisoryId,
            package: exceptionEntry.package,
            expiresOn: exceptionEntry.expiresOn,
          },
        ),
      );
    }
  }

  return {
    ok: errors.length === 0 && violations.length === 0,
    findings,
    violations,
    suppressions,
    errors,
    remediation: {
      localCheck: DEPENDENCY_CHECK_COMMAND,
      auditCommand: policy.auditCommand,
      exceptionsFile: exceptionData.exceptionsPath,
    },
  };
}

// Binary provenance functions
function ensureNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function ensureIsoDay(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
}

function ensureSha256(value, fieldName) {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${fieldName} must be a 64-char hex sha256`);
  }
}

export async function loadBinaryProvenanceMetadata(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const metadataPath = options.metadataPath ?? DEFAULT_METADATA_RELATIVE_PATH;
  const raw = await readFile(toAbsolutePath(repoRoot, metadataPath), 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('metadata must be an object');
  }
  if (!Array.isArray(parsed.trackedBinaryPaths) || parsed.trackedBinaryPaths.length === 0) {
    throw new Error('trackedBinaryPaths must be a non-empty array');
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error('entries must be an array');
  }

  const trackedBinaryPaths = parsed.trackedBinaryPaths.map((value, index) => {
    const normalized = normalizePath(ensureNonEmptyString(value, `trackedBinaryPaths[${index}]`));
    if (path.posix.isAbsolute(normalized) || normalized.startsWith('..')) {
      throw new Error(`trackedBinaryPaths[${index}] must be repository-relative`);
    }
    return normalized;
  });

  const seenTracked = new Set();
  for (const trackedPath of trackedBinaryPaths) {
    if (seenTracked.has(trackedPath)) {
      throw new Error(`trackedBinaryPaths contains duplicate value: ${trackedPath}`);
    }
    seenTracked.add(trackedPath);
  }

  const entries = parsed.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`entries[${index}] must be an object`);
    }

    const entryPath = normalizePath(ensureNonEmptyString(entry.path, `entries[${index}].path`));
    if (path.posix.isAbsolute(entryPath) || entryPath.startsWith('..')) {
      throw new Error(`entries[${index}].path must be repository-relative`);
    }

    const sourceUrl = ensureNonEmptyString(entry.sourceUrl, `entries[${index}].sourceUrl`);
    if (!/^https?:\/\//i.test(sourceUrl)) {
      throw new Error(`entries[${index}].sourceUrl must be an http(s) URL`);
    }

    const sourceRef = ensureNonEmptyString(entry.sourceRef, `entries[${index}].sourceRef`);
    const expectedSha256 = ensureNonEmptyString(entry.expectedSha256, `entries[${index}].expectedSha256`).toLowerCase();
    ensureSha256(expectedSha256, `entries[${index}].expectedSha256`);

    const retrievedOn = ensureNonEmptyString(entry.retrievedOn, `entries[${index}].retrievedOn`);
    ensureIsoDay(retrievedOn, `entries[${index}].retrievedOn`);

    const owner = ensureNonEmptyString(entry.owner, `entries[${index}].owner`);

    if (!Array.isArray(entry.updateProcedure) || entry.updateProcedure.length === 0) {
      throw new Error(`entries[${index}].updateProcedure must be a non-empty array of steps`);
    }

    const updateProcedure = entry.updateProcedure.map((step, stepIndex) =>
      ensureNonEmptyString(step, `entries[${index}].updateProcedure[${stepIndex}]`),
    );

    return {
      path: entryPath,
      sourceUrl,
      sourceRef,
      expectedSha256,
      retrievedOn,
      owner,
      updateProcedure,
    };
  });

  return {
    version: parsed.version ?? 1,
    trackedBinaryPaths,
    entries,
    metadataPath,
  };
}

export async function checkBinaryProvenanceMetadata(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const metadataPath = options.metadataPath ?? DEFAULT_METADATA_RELATIVE_PATH;

  let metadata;
  try {
    metadata = await loadBinaryProvenanceMetadata({ repoRoot, metadataPath });
  } catch (error) {
    return {
      ok: false,
      errors: [
        createError('INVALID_PROVENANCE_SCHEMA', error instanceof Error ? error.message : String(error), {
          path: metadataPath,
        }),
      ],
      checkedEntries: 0,
      remediation: {
        localCheck: PROVENANCE_CHECK_COMMAND,
        metadataFile: metadataPath,
      },
    };
  }

  const errors = [];
  const entryMap = new Map();

  for (const entry of metadata.entries) {
    if (entryMap.has(entry.path)) {
      errors.push(
        createError('DUPLICATE_PROVENANCE_ENTRY', `Duplicate provenance entry for ${entry.path}.`, {
          path: entry.path,
        }),
      );
      continue;
    }
    entryMap.set(entry.path, entry);
  }

  for (const trackedPath of metadata.trackedBinaryPaths) {
    const entry = entryMap.get(trackedPath);
    if (!entry) {
      errors.push(
        createError('MISSING_PROVENANCE_ENTRY', `No provenance entry for tracked binary ${trackedPath}.`, {
          path: trackedPath,
        }),
      );
      continue;
    }

    const absoluteBinaryPath = toAbsolutePath(repoRoot, trackedPath);
    if (!(await pathExists(absoluteBinaryPath))) {
      errors.push(
        createError('MISSING_TRACKED_BINARY', `Tracked binary is missing from repository: ${trackedPath}.`, {
          path: trackedPath,
        }),
      );
      continue;
    }

    const actualSha256 = createHash('sha256').update(await readFile(absoluteBinaryPath)).digest('hex');
    if (actualSha256 !== entry.expectedSha256) {
      errors.push(
        createError(
          'PROVENANCE_HASH_MISMATCH',
          `Hash mismatch for ${trackedPath}: expected ${entry.expectedSha256}, got ${actualSha256}.`,
          {
            path: trackedPath,
            expectedSha256: entry.expectedSha256,
            actualSha256,
          },
        ),
      );
    }
  }

  const trackedSet = new Set(metadata.trackedBinaryPaths);
  for (const entry of metadata.entries) {
    if (!trackedSet.has(entry.path)) {
      errors.push(
        createError('PROVENANCE_UNTRACKED_ENTRY', `Provenance entry is not listed in trackedBinaryPaths: ${entry.path}.`, {
          path: entry.path,
        }),
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    checkedEntries: metadata.entries.length,
    remediation: {
      localCheck: PROVENANCE_CHECK_COMMAND,
      metadataFile: metadata.metadataPath,
    },
  };
}

// CLI helpers
function parseDependencyArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      continue;
    }
    if (value === '--report-file') {
      options.reportFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === '--policy-file') {
      options.policyPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === '--exceptions-file') {
      options.exceptionsPath = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function parseProvenanceArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--metadata-file') {
      options.metadataPath = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function printUsage() {
  console.error(
    'Usage: node scripts/dependency-provenance-compliance.mjs <dependency|provenance|all> <check> [options]',
  );
}

async function runDependencyCommand(options = {}) {
  const result = await runDependencyPolicyCheck(options);

  if (result.ok) {
    console.log(
      `Dependency policy check passed (${result.findings.length} threshold finding(s), ${result.suppressions.length} suppression(s)).`,
    );
    return true;
  }

  console.error('Dependency policy check failed.');
  for (const error of result.errors) {
    console.error(`- [${error.code}] ${error.message}`);
  }
  for (const violation of result.violations) {
    console.error(`- [${violation.code}] ${violation.message}`);
  }
  console.error(`Local check: \`${result.remediation.localCheck}\``);
  if (result.remediation.auditCommand) {
    console.error(`Audit command: \`${result.remediation.auditCommand}\``);
  }
  if (result.remediation.exceptionsFile) {
    console.error(`Exceptions file: \`${result.remediation.exceptionsFile}\` (owner, rationale, expiresOn required).`);
  }

  return false;
}

async function runProvenanceCommand(options = {}) {
  const result = await checkBinaryProvenanceMetadata(options);

  if (result.ok) {
    console.log(`Binary provenance metadata check passed (${result.checkedEntries} entr${result.checkedEntries === 1 ? 'y' : 'ies'} validated).`);
    return true;
  }

  console.error('Binary provenance metadata check failed.');
  for (const error of result.errors) {
    console.error(`- [${error.code}] ${error.message}`);
  }
  console.error(`Local check: \`${result.remediation.localCheck}\``);
  console.error(`Metadata file: \`${result.remediation.metadataFile}\``);

  return false;
}

async function runCli() {
  const [scope, action, ...rest] = process.argv.slice(2);

  if (action !== 'check') {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (scope === 'dependency') {
    const ok = await runDependencyCommand(parseDependencyArgs(rest));
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (scope === 'provenance') {
    const ok = await runProvenanceCommand(parseProvenanceArgs(rest));
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (scope === 'all') {
    const dependencyOk = await runDependencyCommand(parseDependencyArgs(rest));
    const provenanceOk = await runProvenanceCommand(parseProvenanceArgs(rest));
    process.exitCode = dependencyOk && provenanceOk ? 0 : 1;
    return;
  }

  printUsage();
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error('Dependency/provenance compliance command failed with an unexpected error.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
