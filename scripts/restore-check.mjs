import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const EXPECTED_DATABASE = 'deluxe_travel_live';
export const ARCHIVE_FILE = 'deluxe-travel-live.backup';
export const MANIFEST_FILE = 'manifest.json';
export const OUTPUT_DIRECTORY = 'neon-backup-output';
export const REQUIRED_TABLES = Object.freeze([
  'admin_credentials', 'admin_mfa', 'app_sessions', 'auth_attempts', 'bookings',
  'hotel_catalog', 'hotel_partners', 'inventory_items', 'password_reset_tokens',
  'payment_attempts', 'payment_exchange_rates', 'reservations', 'users',
]);

const IMAGE = /^(?:(?:docker\.io\/)?library\/)?postgres:18(?:\.\d+)?-bookworm(?:@sha256:[a-f0-9]{64})?$/u;
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SOCKET = '/var/run/postgresql';
const CODES = new Set([
  'TEMP_CONTEXT_INVALID', 'TARGET_MISMATCH', 'IMAGE_INVALID', 'ARCHIVE_INVALID',
  'ARCHIVE_MISMATCH', 'MANIFEST_INVALID', 'PROCESS_FAILED', 'CONTAINER_START_FAILED',
  'CONTAINER_ID_INVALID', 'READY_TIMEOUT', 'SERVER_VERSION_MISMATCH', 'RESTORE_FAILED',
  'SCHEMA_CHECK_FAILED', 'FILE_OPERATION_FAILED', 'CLEANUP_FAILED', 'RESTORE_CHECK_FAILED',
]);

export class RestoreCheckError extends Error {
  constructor(code) {
    const safeCode = CODES.has(code) ? code : 'RESTORE_CHECK_FAILED';
    super(safeCode);
    this.name = 'RestoreCheckError';
    this.code = safeCode;
  }
}

function fail(code) { throw new RestoreCheckError(code); }

function childEnvironment(env) {
  // Do not inherit source database settings, credentials, arbitrary job secrets,
  // or Docker host overrides. Only local executable/configuration paths are needed.
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT',
    'COMSPEC', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'DOCKER_CONFIG'];
  return Object.fromEntries(allowed.filter((key) => typeof env[key] === 'string')
    .map((key) => [key, env[key]]));
}

/** No shell, stdin, raw stderr forwarding, or unbounded diagnostic capture. */
export function execute(command, args, { env, capture = false, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let finished = false;
    let bytes = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(new RestoreCheckError('PROCESS_FAILED'));
      else resolve(result);
    };
    try {
      child = spawn(command, args, { env, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (chunk) => {
        if (!capture) return;
        bytes += chunk.length;
        if (bytes > 65536) {
          child.kill('SIGKILL');
          finish(true);
        } else chunks.push(chunk);
      });
      child.on('error', () => finish(true));
      child.on('close', (code) => finish(false, {
        code, stdout: capture ? Buffer.concat(chunks).toString('utf8') : '',
      }));
      timer = setTimeout(() => { child.kill('SIGKILL'); finish(true); }, timeoutMs);
      timer.unref();
    } catch {
      child?.kill('SIGKILL');
      finish(true);
    }
  });
}

export function containerArguments({ image, outputPath, cidPath }) {
  return ['run', '--rm', '--detach', '--network', 'none', '--memory', '512m',
    '--cpus', '1', '--pids-limit', '256', '--cidfile', cidPath,
    '--mount', `type=bind,src=${outputPath},dst=/backup,readonly`,
    '--env', `POSTGRES_DB=${EXPECTED_DATABASE}`,
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', image];
}

function scoped(directory, parent) {
  const relative = path.relative(parent, directory);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function checkedFile(filename, { maximumBytes, mode, platform } = {}) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes
      || (platform === 'linux' && mode !== undefined && (stat.mode & 0o777) !== mode)) {
    throw new Error('invalid file');
  }
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino
        || opened.size !== stat.size) throw new Error('changed file');
    return { file, stat: opened };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function loadExport(temp, platform) {
  const outputPath = path.join(temp, OUTPUT_DIRECTORY);
  let outputStat;
  try {
    outputStat = await lstat(outputPath);
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink()
        || await realpath(outputPath) !== outputPath || !scoped(outputPath, temp)
        || (platform === 'linux' && (outputStat.mode & 0o777) !== 0o700)) {
      fail('TEMP_CONTEXT_INVALID');
    }
  } catch { fail('TEMP_CONTEXT_INVALID'); }
  let manifest;
  try {
    const { file } = await checkedFile(path.join(outputPath, MANIFEST_FILE), {
      maximumBytes: 65536, mode: 0o600, platform,
    });
    try { manifest = JSON.parse(await file.readFile('utf8')); }
    finally { await file.close(); }
    if (!manifest || Array.isArray(manifest) || manifest.manifestVersion !== 1
        || manifest.database !== EXPECTED_DATABASE || manifest.archive !== ARCHIVE_FILE
        || manifest.format !== 'PostgreSQL custom' || manifest.postgresMajor !== 18
        || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 5
        || !/^[a-f0-9]{64}$/u.test(manifest.sha256)
        || manifest.verification?.magic !== 'PGDMP'
        || manifest.verification?.restoreList !== true
        || manifest.verification?.requiredTableDefinitions !== REQUIRED_TABLES.length
        || manifest.verification?.requiredTableData !== REQUIRED_TABLES.length) {
      fail('MANIFEST_INVALID');
    }
  } catch { fail('MANIFEST_INVALID'); }
  const archivePath = path.join(outputPath, ARCHIVE_FILE);
  let archive;
  try {
    archive = await checkedFile(archivePath, { maximumBytes: 1024 * 1024 * 1024,
      mode: 0o600, platform });
    const magic = Buffer.alloc(5);
    await archive.file.read(magic, 0, 5, 0);
    if (archive.stat.size <= 5 || magic.toString('ascii') !== 'PGDMP') fail('ARCHIVE_INVALID');
  } catch {
    await archive?.file.close();
    fail('ARCHIVE_INVALID');
  }
  let sha256;
  try {
    const hash = createHash('sha256');
    // Keep the checked file descriptor open while hashing; never materialize SQL.
    for await (const chunk of createReadStream(archivePath, {
      fd: archive.file.fd, autoClose: false, start: 0,
    })) hash.update(chunk);
    sha256 = hash.digest('hex');
  } finally { await archive.file.close(); }
  if (archive.stat.size !== manifest.bytes || sha256 !== manifest.sha256) fail('ARCHIVE_MISMATCH');
  return { outputPath, archivePath, manifest };
}

async function safeRemoveOwned(directory, temp) {
  if (path.dirname(directory) !== temp || !scoped(directory, temp)
      || !path.basename(directory).startsWith('deluxe-neon-restore-')) fail('CLEANUP_FAILED');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) {
    fail('CLEANUP_FAILED');
  }
  await rm(directory, { recursive: true, force: true });
}

async function readContainerId(cidPath) {
  try {
    const { file } = await checkedFile(cidPath, { maximumBytes: 128 });
    let value;
    try { value = (await file.readFile('utf8')).trim(); }
    finally { await file.close(); }
    return CONTAINER_ID.test(value) ? value : undefined;
  } catch { return undefined; }
}

async function publishManifest(manifest, stagingPath, outputPath, temp) {
  if (path.dirname(stagingPath) !== temp || !scoped(stagingPath, temp)
      || outputPath !== path.join(temp, OUTPUT_DIRECTORY)) fail('TEMP_CONTEXT_INVALID');
  for (const directory of [stagingPath, outputPath]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) {
      fail('TEMP_CONTEXT_INVALID');
    }
  }
  const staged = path.join(stagingPath, 'manifest-next.json');
  await writeFile(staged, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(staged, 0o600);
  // Rename replaces the file itself, so a hard-linked input cannot be overwritten.
  await rename(staged, path.join(outputPath, MANIFEST_FILE));
}

const TABLE_SQL = `SELECT c.relname FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
AND c.relname IN (${REQUIRED_TABLES.map((table) => `'${table}'`).join(', ')})
ORDER BY c.relname;`;

export async function runRestoreCheck({ env = process.env, runProcess = execute,
  platform = process.platform, now = () => new Date(), clock = () => performance.now(),
  sleep = delay, readyTimeoutMs = 60000,
} = {}) {
  if (env.EXPECTED_DATABASE && env.EXPECTED_DATABASE !== EXPECTED_DATABASE) fail('TARGET_MISMATCH');
  const image = env.POSTGRES_IMAGE || 'postgres:18-bookworm';
  if (!IMAGE.test(image)) fail('IMAGE_INVALID');
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP) || CONTROL.test(env.RUNNER_TEMP)
      || env.RUNNER_TEMP.includes(',') || !Number.isSafeInteger(readyTimeoutMs)
      || readyTimeoutMs < 1 || readyTimeoutMs > 60000) fail('TEMP_CONTEXT_INVALID');
  let temp;
  try {
    const stat = await lstat(env.RUNNER_TEMP);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('TEMP_CONTEXT_INVALID');
    temp = await realpath(env.RUNNER_TEMP);
    if (temp === path.parse(temp).root) fail('TEMP_CONTEXT_INVALID');
  } catch { fail('TEMP_CONTEXT_INVALID'); }
  let exported;
  try { exported = await loadExport(temp, platform); }
  catch (error) {
    throw error instanceof RestoreCheckError ? error : new RestoreCheckError('FILE_OPERATION_FAILED');
  }
  const processEnv = childEnvironment(env);
  let stagingPath;
  let cidPath;
  let containerId;
  let failure;
  let check;
  const invoke = async (args, code, options = {}) => {
    try {
      const child = await runProcess('docker', args, { env: processEnv, ...options });
      if (!child || child.code !== 0) fail(code);
      return typeof child.stdout === 'string' ? child.stdout : '';
    } catch { fail(code); }
  };
  try {
    stagingPath = await mkdtemp(path.join(temp, 'deluxe-neon-restore-'));
    await chmod(stagingPath, 0o700);
    cidPath = path.join(stagingPath, 'container.id');
    // A repeated check cannot leave an earlier pass in place if this attempt fails.
    if (Object.hasOwn(exported.manifest, 'restoreCheck')) {
      delete exported.manifest.restoreCheck;
      await publishManifest(exported.manifest, stagingPath, exported.outputPath, temp);
    }
    const started = (await invoke(containerArguments({ image,
      outputPath: exported.outputPath, cidPath }), 'CONTAINER_START_FAILED', {
      capture: true, timeoutMs: 120000,
    })).trim();
    // Capture only a complete Docker ID. Never clean up by name or enumeration.
    if (!CONTAINER_ID.test(started)) fail('CONTAINER_ID_INVALID');
    const fromFile = await readContainerId(cidPath);
    containerId = fromFile;
    if (fromFile !== started) fail('CONTAINER_ID_INVALID');
    const exec = ['exec', '--user', '0', containerId];
    const connection = ['--no-password', '--username=postgres', `--host=${SOCKET}`,
      `--dbname=${EXPECTED_DATABASE}`];
    const deadline = clock() + readyTimeoutMs;
    let ready = false;
    for (let attempt = 0; attempt < 60 && clock() < deadline; attempt += 1) {
      try {
        // The official image's temporary initialization server only listens on
        // Unix sockets. Loopback TCP becomes ready on the final server, after
        // POSTGRES_DB creation and the initialization server's shutdown.
        const child = await runProcess('docker', [...exec, 'pg_isready', '--quiet',
          '--username=postgres', '--host=127.0.0.1', `--dbname=${EXPECTED_DATABASE}`], {
          env: processEnv, capture: false, timeoutMs: Math.max(1, Math.min(2000, deadline - clock())),
        });
        if (child?.code === 0 && clock() < deadline) { ready = true; break; }
      } catch { /* Initialization may not be ready yet; diagnostics stay private. */ }
      const remaining = deadline - clock();
      if (remaining > 0) await sleep(Math.min(1000, remaining));
    }
    if (!ready) fail('READY_TIMEOUT');
    const psql = [...exec, 'psql', '--no-psqlrc', ...connection, '--tuples-only', '--no-align',
      '--set=ON_ERROR_STOP=1'];
    const version = (await invoke([...psql, '--command=SHOW server_version_num;'],
      'SERVER_VERSION_MISMATCH', { capture: true, timeoutMs: 30000 })).trim();
    if (!/^18\d{4}$/u.test(version)) fail('SERVER_VERSION_MISMATCH');
    // The image entrypoint initializes as root. Exec also uses root so a host UID
    // 1001 archive with mode 0600 remains readable through the read-only bind.
    await invoke([...exec, 'pg_restore', ...connection, '--single-transaction', '--exit-on-error',
      '--no-owner', '--no-acl', '--no-tablespaces', `/backup/${ARCHIVE_FILE}`],
    'RESTORE_FAILED', { timeoutMs: 1200000 });
    const names = (await invoke([...psql, `--command=${TABLE_SQL}`], 'SCHEMA_CHECK_FAILED', {
      capture: true, timeoutMs: 30000,
    })).trim().split(/\r?\n/u);
    if (names.length !== REQUIRED_TABLES.length || new Set(names).size !== names.length
        || REQUIRED_TABLES.some((table) => !names.includes(table))) fail('SCHEMA_CHECK_FAILED');
    check = { status: 'passed', checkedAt: now().toISOString(), postgresMajor: 18,
      requiredPublicTables: REQUIRED_TABLES.length };
  } catch (error) {
    failure = error instanceof RestoreCheckError ? error : new RestoreCheckError('FILE_OPERATION_FAILED');
  }
  // cidfile recovery also covers a client timeout after Docker created the server.
  if (!containerId && cidPath) containerId = await readContainerId(cidPath);
  if (containerId) {
    try { await invoke(['rm', '--force', '--volumes', containerId], 'CLEANUP_FAILED', { timeoutMs: 30000 }); }
    catch { failure = new RestoreCheckError('CLEANUP_FAILED'); }
  }
  if (!failure) {
    try {
      exported.manifest.restoreCheck = check;
      await publishManifest(exported.manifest, stagingPath, exported.outputPath, temp);
    } catch { failure = new RestoreCheckError('FILE_OPERATION_FAILED'); }
  }
  if (stagingPath) {
    try { await safeRemoveOwned(stagingPath, temp); }
    catch { failure = new RestoreCheckError('CLEANUP_FAILED'); }
  }
  if (failure) throw failure;
  return { ...exported, restoreCheck: check };
}

export async function main(options = {}) {
  try {
    await runRestoreCheck(options);
    process.stdout.write('Isolated restore check passed.\n');
    return 0;
  } catch (error) {
    const code = error instanceof RestoreCheckError ? error.code : 'RESTORE_CHECK_FAILED';
    process.stderr.write(`Isolated restore check failed: ${code}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
