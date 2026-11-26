import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARCHIVE_FILE, CHECKSUM_FILE, EXPECTED_DATABASE, EXPECTED_HOST,
  MANIFEST_FILE, OUTPUT_DIRECTORY, REQUIRED_TABLES } from './backup.mjs';

export const ENCRYPTED_DIRECTORY = 'neon-backup-encrypted';
export const ENCRYPTED_FILE = 'deluxe-travel-live.tar.gpg';
const INPUT_FILES = [ARCHIVE_FILE, CHECKSUM_FILE, MANIFEST_FILE];
const MAXIMUM_BYTES = 25 * 1024 * 1024;
const CODES = new Set(['KEY_MISSING', 'KEY_INVALID', 'TOOLS_UNAVAILABLE', 'TEMP_CONTEXT_INVALID',
  'EXPORT_INVALID', 'OUTPUT_EXISTS', 'PACKAGING_FAILED', 'ENCRYPTION_FAILED',
  'DECRYPTION_CHECK_FAILED', 'FILE_OPERATION_FAILED', 'CLEANUP_FAILED']);

export class EncryptionError extends Error {
  constructor(code) {
    const safeCode = CODES.has(code) ? code : 'ENCRYPTION_FAILED';
    super(safeCode);
    this.name = 'EncryptionError';
    this.code = safeCode;
  }
}
function fail(code) { throw new EncryptionError(code); }
export function parseKey(value) {
  if (typeof value !== 'string' || !value.trim()) fail('KEY_MISSING');
  const key = value.trim();
  if (!/^[a-f0-9]{64}$/iu.test(key)) fail('KEY_INVALID');
  return key;
}
function childEnvironment(env) {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT',
    'COMSPEC', 'HOME', 'USERPROFILE', 'TEMP', 'TMP'];
  return Object.fromEntries(allowed.filter((key) => typeof env[key] === 'string')
    .map((key) => [key, env[key]]));
}

/** Credentials only enter a child's private stdin; raw diagnostics never escape. */
export function execute(command, args, { env, input, capture = false, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let finished = false;
    let bytes = 0;
    const output = [];
    const finish = (failed, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (failed) reject(new EncryptionError('ENCRYPTION_FAILED'));
      else resolve(result);
    };
    try {
      child = spawn(command, args, { env, shell: false, windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
      child.stdout.on('data', (chunk) => {
        if (!capture) return;
        bytes += chunk.length;
        if (bytes > 65536) { child.kill('SIGKILL'); finish(true); }
        else output.push(chunk);
      });
      child.stdout.on('error', () => { child.kill('SIGKILL'); finish(true); });
      child.on('error', () => finish(true));
      child.on('close', (code) => finish(false, {
        code, stdout: capture ? Buffer.concat(output).toString('utf8') : '',
      }));
      if (input !== undefined) {
        child.stdin.on('error', () => { child.kill('SIGKILL'); finish(true); });
        child.stdin.end(input);
      }
      timer = setTimeout(() => { child.kill('SIGKILL'); finish(true); }, timeoutMs);
      timer.unref();
    } catch { child?.kill('SIGKILL'); finish(true); }
  });
}
async function invoke(runProcess, command, args, options, code) {
  try {
    const result = await runProcess(command, args, options);
    if (result?.code !== 0) fail(code);
    return result.stdout || '';
  } catch { fail(code); }
}

export async function checkConfig({ env = process.env, runProcess = execute } = {}) {
  parseKey(env.NEON_BACKUP_ENCRYPTION_KEY);
  const options = { env: childEnvironment(env), capture: true, timeoutMs: 15000 };
  const version = await invoke(runProcess, 'gpg', ['--no-options', '--version'], options, 'TOOLS_UNAVAILABLE');
  const match = /^gpg \(GnuPG\) (\d+)\.(\d+)(?:\.|\s)/u.exec(version);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 2)) {
    fail('TOOLS_UNAVAILABLE');
  }
  await invoke(runProcess, 'tar', ['--version'], options, 'TOOLS_UNAVAILABLE');
}

async function checkedRead(filename, maximumBytes, platform) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes
      || (platform === 'linux' && (stat.mode & 0o777) !== 0o600)) fail('EXPORT_INVALID');
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino
        || opened.size !== stat.size) fail('EXPORT_INVALID');
    const bytes = await file.readFile();
    if (bytes.length !== stat.size) fail('EXPORT_INVALID');
    return bytes;
  } finally { await file.close(); }
}
async function loadExport(temp, platform) {
  try {
    const source = path.join(temp, OUTPUT_DIRECTORY);
    const stat = await lstat(source);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(source) !== source
        || (platform === 'linux' && (stat.mode & 0o777) !== 0o700)
        || (await readdir(source)).sort().join('\n') !== [...INPUT_FILES].sort().join('\n')) fail('EXPORT_INVALID');
    const archive = await checkedRead(path.join(source, ARCHIVE_FILE), MAXIMUM_BYTES, platform);
    const manifestBytes = await checkedRead(path.join(source, MANIFEST_FILE), 65536, platform);
    const checksum = await checkedRead(path.join(source, CHECKSUM_FILE), 256, platform);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const hash = createHash('sha256').update(archive).digest('hex');
    if (archive.length <= 5 || archive.subarray(0, 5).toString('ascii') !== 'PGDMP'
        || manifest?.manifestVersion !== 1 || manifest.database !== EXPECTED_DATABASE
        || manifest.host !== EXPECTED_HOST || manifest.archive !== ARCHIVE_FILE
        || manifest.format !== 'PostgreSQL custom' || manifest.postgresMajor !== 18
        || manifest.bytes !== archive.length || manifest.sha256 !== hash
        || checksum.toString('utf8') !== `${hash}  ${ARCHIVE_FILE}\n`
        || manifest.verification?.magic !== 'PGDMP' || manifest.verification?.restoreList !== true
        || manifest.verification?.requiredTableDefinitions !== REQUIRED_TABLES.length
        || manifest.verification?.requiredTableData !== REQUIRED_TABLES.length
        || manifest.restoreCheck?.status !== 'passed' || manifest.restoreCheck.postgresMajor !== 18
        || manifest.restoreCheck.requiredPublicTables !== REQUIRED_TABLES.length
        || typeof manifest.restoreCheck.checkedAt !== 'string'
        || !Number.isFinite(Date.parse(manifest.restoreCheck.checkedAt))) fail('EXPORT_INVALID');
    return { [ARCHIVE_FILE]: archive, [CHECKSUM_FILE]: checksum, [MANIFEST_FILE]: manifestBytes };
  } catch { fail('EXPORT_INVALID'); }
}
async function removeOwned(directory, temp) {
  if (path.dirname(directory) !== temp || !(path.basename(directory).startsWith('deluxe-neon-encrypt-')
      || path.basename(directory) === ENCRYPTED_DIRECTORY)) fail('CLEANUP_FAILED');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) fail('CLEANUP_FAILED');
  await rm(directory, { recursive: true, force: true });
}

export async function runEncryption({ env = process.env, runProcess = execute, platform = process.platform } = {}) {
  await checkConfig({ env, runProcess });
  const key = parseKey(env.NEON_BACKUP_ENCRYPTION_KEY);
  let temp;
  try {
    if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP) || /[\u0000-\u001f\u007f]/u.test(env.RUNNER_TEMP)) fail('TEMP_CONTEXT_INVALID');
    const stat = await lstat(env.RUNNER_TEMP);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('TEMP_CONTEXT_INVALID');
    temp = await realpath(env.RUNNER_TEMP);
    if (temp === path.parse(temp).root) fail('TEMP_CONTEXT_INVALID');
  } catch { fail('TEMP_CONTEXT_INVALID'); }
  if ((env.EXPECTED_DATABASE && env.EXPECTED_DATABASE !== EXPECTED_DATABASE)
      || (env.EXPECTED_HOST && env.EXPECTED_HOST !== EXPECTED_HOST)) fail('EXPORT_INVALID');
  const files = await loadExport(temp, platform);
  const outputPath = path.join(temp, ENCRYPTED_DIRECTORY);
  if (await lstat(outputPath).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error))) fail('OUTPUT_EXISTS');
  let stage;
  let ownsOutput = false;
  let failure;
  let result;
  try {
    stage = await mkdtemp(path.join(temp, 'deluxe-neon-encrypt-'));
    await chmod(stage, 0o700);
    const source = path.join(stage, 'source');
    const home = path.join(stage, 'gnupg');
    for (const directory of [source, home]) { await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700); }
    for (const filename of INPUT_FILES) await writeFile(path.join(source, filename), files[filename], { mode: 0o600, flag: 'wx' });
    const processEnv = childEnvironment(env);
    const options = { env: processEnv, timeoutMs: 120000 };
    const tarPath = path.join(stage, 'deluxe-backup.tar');
    await invoke(runProcess, 'tar', ['--create', '--file', tarPath, '--directory', source, '--', ...INPUT_FILES], options, 'PACKAGING_FAILED');
    await chmod(tarPath, 0o600);
    const tarBytes = await checkedRead(tarPath, MAXIMUM_BYTES + 1024 * 1024, platform);
    const ciphertext = path.join(stage, ENCRYPTED_FILE);
    const common = ['--no-options', '--homedir', home, '--batch', '--no-tty', '--no-symkey-cache',
      '--pinentry-mode', 'loopback', '--passphrase-fd', '0'];
    const secretOptions = { ...options, input: `${key}\n` };
    await invoke(runProcess, 'gpg', [...common, '--cipher-algo', 'AES256', '--s2k-digest-algo', 'SHA512',
      '--s2k-mode', '3', '--s2k-count', '65011712', '--force-mdc', '--compress-algo', 'none',
      '--set-filename', 'deluxe-backup.tar', '--output', ciphertext, '--symmetric', tarPath], secretOptions, 'ENCRYPTION_FAILED');
    await chmod(ciphertext, 0o600);
    const encryptedBytes = await checkedRead(ciphertext, MAXIMUM_BYTES + 2 * 1024 * 1024, platform);
    if (encryptedBytes.length < 32 || (encryptedBytes[0] & 0x80) === 0) fail('ENCRYPTION_FAILED');
    const decrypted = path.join(stage, 'verified.tar');
    await invoke(runProcess, 'gpg', [...common, '--output', decrypted, '--decrypt', ciphertext], secretOptions, 'DECRYPTION_CHECK_FAILED');
    await chmod(decrypted, 0o600);
    const verified = await checkedRead(decrypted, MAXIMUM_BYTES + 1024 * 1024, platform);
    if (!tarBytes.equals(verified)) fail('DECRYPTION_CHECK_FAILED');
    try { await mkdir(outputPath, { mode: 0o700 }); ownsOutput = true; }
    catch (error) { if (error.code === 'EEXIST') fail('OUTPUT_EXISTS'); throw error; }
    await chmod(outputPath, 0o700);
    await copyFile(ciphertext, path.join(outputPath, ENCRYPTED_FILE), constants.COPYFILE_EXCL);
    await chmod(path.join(outputPath, ENCRYPTED_FILE), 0o600);
    const sha256 = createHash('sha256').update(encryptedBytes).digest('hex');
    await writeFile(path.join(outputPath, CHECKSUM_FILE), `${sha256}  ${ENCRYPTED_FILE}\n`, { mode: 0o600, flag: 'wx' });
    result = { outputPath, encryptedPath: path.join(outputPath, ENCRYPTED_FILE), sha256 };
  } catch (error) { failure = error instanceof EncryptionError ? error : new EncryptionError('FILE_OPERATION_FAILED'); }
  if (stage) {
    try { await removeOwned(stage, temp); }
    catch { failure = new EncryptionError('CLEANUP_FAILED'); }
  }
  if (failure) {
    if (ownsOutput) { try { await removeOwned(outputPath, temp); } catch { failure = new EncryptionError('CLEANUP_FAILED'); } }
    throw failure;
  }
  return result;
}

export async function main({ checkOnly = false, ...options } = {}) {
  try {
    if (checkOnly) await checkConfig(options);
    else await runEncryption(options);
    process.stdout.write(checkOnly ? 'Encryption configuration ready.\n' : 'Encrypted backup and recovery check passed.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`Backup encryption failed: ${error instanceof EncryptionError ? error.code : 'ENCRYPTION_FAILED'}\n`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main({ checkOnly: process.argv.slice(2).length === 1 && process.argv[2] === '--check-config' });
}
