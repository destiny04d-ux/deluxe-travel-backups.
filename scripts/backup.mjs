import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_DATABASE = 'deluxe_travel_live';
export const EXPECTED_HOST = 'ep-odd-boat-bfu600w6.c-5.us-west-2.aws.neon.tech';
export const ARCHIVE_FILE = 'deluxe-travel-live.backup';
export const CHECKSUM_FILE = 'SHA256SUMS';
export const MANIFEST_FILE = 'manifest.json';
export const OUTPUT_DIRECTORY = 'neon-backup-output';
export const REQUIRED_TABLES = Object.freeze([
  'admin_credentials', 'admin_mfa', 'app_sessions', 'auth_attempts', 'bookings',
  'hotel_catalog', 'hotel_partners', 'inventory_items', 'password_reset_tokens',
  'payment_attempts', 'payment_exchange_rates', 'reservations', 'users',
]);

const ERROR_CODES = new Set([
  'CONFIG_MISSING', 'DATABASE_URL_INVALID', 'TARGET_MISMATCH', 'TLS_OPTIONS_INVALID',
  'TEMP_CONTEXT_INVALID', 'OUTPUT_EXISTS', 'IMAGE_INVALID', 'PERMISSIONS_INVALID',
  'DOCKER_FAILED', 'CLIENT_VERSION_MISMATCH', 'DUMP_FAILED', 'ARCHIVE_INVALID',
  'ARCHIVE_TOO_LARGE', 'RESTORE_LIST_FAILED', 'ARCHIVE_CONTENTS_INVALID',
  'FILE_OPERATION_FAILED', 'CLEANUP_FAILED', 'BACKUP_FAILED',
]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const IMAGE = /^(?:(?:docker\.io\/)?library\/)?postgres:18(?:\.\d+)?-bookworm(?:@sha256:[a-f0-9]{64})?$/u;

export class BackupError extends Error {
  constructor(code) {
    const safeCode = ERROR_CODES.has(code) ? code : 'BACKUP_FAILED';
    super(safeCode);
    this.name = 'BackupError';
    this.code = safeCode;
  }
}

function fail(code) { throw new BackupError(code); }

/** Parse credentials privately. Never log this result or the input URL. */
export function parseDatabaseUrl(value, {
  expectedDatabase = EXPECTED_DATABASE, expectedHost = EXPECTED_HOST,
} = {}) {
  if (typeof value !== 'string' || value.length === 0) fail('CONFIG_MISSING');
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/u.test(expectedDatabase)
      || !/^[a-z0-9.-]+$/u.test(expectedHost) || expectedHost.includes('-pooler')) {
    fail('TARGET_MISMATCH');
  }
  if (value.length > 16384 || CONTROL.test(value) || /\s/u.test(value)
      || value.includes('#') || /%(?![a-f0-9]{2})/iu.test(value)) {
    fail('DATABASE_URL_INVALID');
  }
  let url;
  let username;
  let password;
  let database;
  try {
    url = new URL(value);
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
    // URLSearchParams otherwise replaces malformed UTF-8 instead of rejecting it.
    decodeURIComponent(url.search.replace(/\+/gu, '%20'));
  } catch {
    fail('DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !username || !password || CONTROL.test(username) || CONTROL.test(password)
      || url.hash || url.pathname[0] !== '/') fail('DATABASE_URL_INVALID');
  if (url.hostname !== expectedHost || url.hostname.includes('-pooler')
      || (url.port && url.port !== '5432') || database !== expectedDatabase) {
    fail('TARGET_MISMATCH');
  }
  const validators = {
    sslmode: /^(require|verify-ca|verify-full)$/u,
    channel_binding: /^(require|prefer)$/u,
    connect_timeout: /^(?:[1-9]\d?|[12]\d\d|300)$/u,
    sslrootcert: /^system$/u,
  };
  const seen = new Set();
  for (const [key, setting] of url.searchParams) {
    if (!Object.hasOwn(validators, key) || seen.has(key) || !validators[key].test(setting)) {
      fail('TLS_OPTIONS_INVALID');
    }
    seen.add(key);
  }
  return Object.freeze({ host: expectedHost, port: '5432', database, username, password });
}

export function escapePgpass(value) {
  if (typeof value !== 'string' || CONTROL.test(value)) fail('DATABASE_URL_INVALID');
  return value.replace(/\\/gu, '\\\\').replace(/:/gu, '\\:');
}

export function pgpassLine(config) {
  return [config.host, config.port, config.database, config.username, config.password]
    .map(escapePgpass).join(':') + '\n';
}

export function connectionEnvironment(config) {
  return {
    PGHOST: config.host, PGPORT: config.port, PGDATABASE: config.database,
    PGUSER: config.username, PGSSLMODE: 'verify-full', PGSSLROOTCERT: 'system',
    PGCHANNELBINDING: 'require', PGCONNECT_TIMEOUT: '30', PGPASSFILE: '/run/secrets/pgpass',
  };
}

function childEnvironment(env) {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT',
    'COMSPEC', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'DOCKER_CONFIG'];
  return Object.fromEntries(allowed.filter((key) => typeof env[key] === 'string')
    .map((key) => [key, env[key]]));
}

/** No shell, inherited secrets, stderr forwarding, or unbounded output. */
export function execute(command, args, { env, capture = false, timeoutMs = 1200000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let finished = false;
    let outputBytes = 0;
    const output = [];
    let timer;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(new BackupError('DOCKER_FAILED'));
      else resolve(result);
    };
    try {
      child = spawn(command, args, { env, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (chunk) => {
        if (!capture) return;
        outputBytes += chunk.length;
        if (outputBytes > 8 * 1024 * 1024) {
          child.kill('SIGKILL');
          finish(true);
        } else output.push(chunk);
      });
      child.stdout.on('error', () => { child.kill('SIGKILL'); finish(true); });
      child.on('error', () => finish(true));
      child.on('close', (code) => finish(false, {
        code, stdout: capture ? Buffer.concat(output).toString('utf8') : '',
      }));
      timer = setTimeout(() => { child.kill('SIGKILL'); finish(true); }, timeoutMs);
      timer.unref();
    } catch {
      child?.kill('SIGKILL');
      finish(true);
    }
  });
}

export function dockerArguments({ image, platform, uid, gid, outputPath,
  pgpassPath, connection, readOnlyOutput = false, network = 'none' }) {
  const args = ['run', '--rm', '--network', network, '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m'];
  if (platform === 'linux') {
    if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
      fail('TEMP_CONTEXT_INVALID');
    }
    args.push('--user', `${uid}:${gid}`);
  }
  args.push('--env', 'HOME=/tmp');
  if (outputPath) args.push('--mount',
    `type=bind,src=${outputPath},dst=/backup${readOnlyOutput ? ',readonly' : ''}`);
  if (pgpassPath) args.push('--mount',
    `type=bind,src=${pgpassPath},dst=/run/secrets/pgpass,readonly`);
  if (connection) {
    for (const [key, value] of Object.entries(connectionEnvironment(connection))) {
      args.push('--env', `${key}=${value}`);
    }
  }
  args.push(image);
  return args;
}

export function validateArchiveToc(toc, {
  requiredTables = REQUIRED_TABLES, expectedDatabase = EXPECTED_DATABASE,
} = {}) {
  if (typeof toc !== 'string'
      || !/^;\s+Dumped from database version:?\s+18(?:[.\s]|$)/mu.test(toc)
      || !/^;\s+Dumped by pg_dump version:?\s+18(?:[.\s]|$)/mu.test(toc)
      || /^;\s+dbname:\s+(\S+)\s*$/mu.exec(toc)?.[1] !== expectedDatabase) {
    fail('ARCHIVE_CONTENTS_INVALID');
  }
  const definitions = new Set();
  const data = new Set();
  for (const line of toc.split(/\r?\n/u)) {
    const match = /^\d+;\s+\d+\s+\d+\s+TABLE\s+(DATA\s+)?public\s+(\S+)(?:\s|$)/u.exec(line);
    if (match) (match[1] ? data : definitions).add(match[2]);
  }
  if (requiredTables.some((table) => !definitions.has(table) || !data.has(table))) {
    fail('ARCHIVE_CONTENTS_INVALID');
  }
  return { requiredTableDefinitions: requiredTables.length, requiredTableData: requiredTables.length };
}

async function checkPermissions(file, expected, platform) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || (platform === 'linux' && (stat.mode & 0o777) !== expected)) {
    fail('PERMISSIONS_INVALID');
  }
}

async function safeRemoveOwned(directory, parent, basename) {
  if (!directory || path.dirname(directory) !== parent || path.basename(directory) !== basename) {
    fail('CLEANUP_FAILED');
  }
  const stat = await lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) {
    fail('CLEANUP_FAILED');
  }
  await rm(directory, { recursive: true, force: true });
}

export async function runBackup({ env = process.env, runProcess = execute,
  platform = process.platform, uid = process.getuid?.(), gid = process.getgid?.(),
  now = () => new Date(),
} = {}) {
  const config = parseDatabaseUrl(env.NEON_BACKUP_DATABASE_URL, {
    expectedDatabase: env.EXPECTED_DATABASE || EXPECTED_DATABASE,
    expectedHost: env.EXPECTED_HOST || EXPECTED_HOST,
  });
  const image = env.POSTGRES_IMAGE || 'postgres:18-bookworm';
  if (!IMAGE.test(image)) fail('IMAGE_INVALID');
  const maxMiB = env.MAX_BACKUP_MIB || '25';
  if (!/^[1-9]\d{0,3}$/u.test(maxMiB) || Number(maxMiB) > 1024) fail('CONFIG_MISSING');
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)
      || CONTROL.test(env.RUNNER_TEMP) || env.RUNNER_TEMP.includes(',')) fail('TEMP_CONTEXT_INVALID');
  let temp;
  try {
    const stat = await lstat(env.RUNNER_TEMP);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('TEMP_CONTEXT_INVALID');
    temp = await realpath(env.RUNNER_TEMP);
    if (temp === path.parse(temp).root) fail('TEMP_CONTEXT_INVALID');
  } catch { fail('TEMP_CONTEXT_INVALID'); }
  const outputPath = path.join(temp, OUTPUT_DIRECTORY);
  const processEnv = childEnvironment(env);
  const identity = { image, platform, uid, gid };
  let stagingPath;
  let ownsOutput = false;
  let failure;
  let result;
  const invoke = async (args, code, options = {}) => {
    try {
      const child = await runProcess('docker', args, { env: processEnv, ...options });
      if (!child || child.code !== 0) fail(code);
      return typeof child.stdout === 'string' ? child.stdout : '';
    } catch { fail(code); }
  };
  try {
    try {
      await mkdir(outputPath, { mode: 0o700 });
      ownsOutput = true;
    } catch (error) {
      if (error.code === 'EEXIST') fail('OUTPUT_EXISTS');
      throw error;
    }
    await chmod(outputPath, 0o700);
    await checkPermissions(outputPath, 0o700, platform);
    stagingPath = await mkdtemp(path.join(temp, 'deluxe-neon-private-'));
    await chmod(stagingPath, 0o700);
    await checkPermissions(stagingPath, 0o700, platform);
    const privateOutput = path.join(stagingPath, 'output');
    await mkdir(privateOutput, { mode: 0o700 });
    await chmod(privateOutput, 0o700);
    const pgpassPath = path.join(stagingPath, 'pgpass');
    await writeFile(pgpassPath, pgpassLine(config), { mode: 0o600, flag: 'wx' });
    await chmod(pgpassPath, 0o600);
    await checkPermissions(pgpassPath, 0o600, platform);
    for (const program of ['pg_dump', 'pg_restore']) {
      const version = await invoke([...dockerArguments(identity), program, '--version'],
        'DOCKER_FAILED', { capture: true, timeoutMs: 120000 });
      if (!new RegExp(`^${program} \\(PostgreSQL\\) 18(?:\\.\\d+)*(?:[\\s-]|$)`, 'u').test(version)) {
        fail('CLIENT_VERSION_MISMATCH');
      }
    }
    await invoke([...dockerArguments({ ...identity, outputPath: privateOutput, pgpassPath,
      connection: config, network: 'bridge' }), 'pg_dump', '--no-password', '--format=custom',
    '--compress=gzip:9', `--file=/backup/${ARCHIVE_FILE}`], 'DUMP_FAILED');
    const archivePath = path.join(privateOutput, ARCHIVE_FILE);
    let archiveStat;
    try { archiveStat = await lstat(archivePath); } catch { fail('ARCHIVE_INVALID'); }
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size <= 5) {
      fail('ARCHIVE_INVALID');
    }
    if (archiveStat.size > Number(maxMiB) * 1024 * 1024) fail('ARCHIVE_TOO_LARGE');
    await chmod(archivePath, 0o600);
    const archive = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const magic = Buffer.alloc(5);
      await archive.read(magic, 0, 5, 0);
      if (magic.toString('ascii') !== 'PGDMP') fail('ARCHIVE_INVALID');
    } finally { await archive.close(); }
    const toc = await invoke([...dockerArguments({ ...identity, outputPath: privateOutput,
      readOnlyOutput: true }), 'pg_restore', '--list', `/backup/${ARCHIVE_FILE}`],
    'RESTORE_LIST_FAILED', { capture: true, timeoutMs: 120000 });
    const verification = validateArchiveToc(toc, { expectedDatabase: config.database });
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const manifest = {
      manifestVersion: 1, createdAt: now().toISOString(), database: config.database,
      host: config.host, archive: ARCHIVE_FILE, format: 'PostgreSQL custom',
      postgresMajor: 18, clientImage: image, bytes: archiveStat.size, sha256,
      verification: { magic: 'PGDMP', restoreList: true, ...verification },
    };
    await writeFile(path.join(privateOutput, CHECKSUM_FILE), `${sha256}  ${ARCHIVE_FILE}\n`,
      { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(privateOutput, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' });
    for (const filename of [ARCHIVE_FILE, CHECKSUM_FILE, MANIFEST_FILE]) {
      const destination = path.join(outputPath, filename);
      await copyFile(path.join(privateOutput, filename), destination, constants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
    }
    result = { outputPath, archivePath: path.join(outputPath, ARCHIVE_FILE), manifest };
  } catch (error) {
    failure = error instanceof BackupError ? error : new BackupError('FILE_OPERATION_FAILED');
  }
  if (stagingPath) {
    try { await safeRemoveOwned(stagingPath, temp, path.basename(stagingPath)); }
    catch { failure = new BackupError('CLEANUP_FAILED'); }
  }
  if (failure) {
    if (ownsOutput) {
      try { await safeRemoveOwned(outputPath, temp, OUTPUT_DIRECTORY); }
      catch { failure = new BackupError('CLEANUP_FAILED'); }
    }
    throw failure;
  }
  return result;
}

export async function main(options = {}) {
  try {
    await runBackup(options);
    process.stdout.write(`Backup ready: ${ARCHIVE_FILE}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof BackupError ? error.code : 'BACKUP_FAILED';
    process.stderr.write(`Backup failed: ${code}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
