import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_FILE, CHECKSUM_FILE, EXPECTED_DATABASE, EXPECTED_HOST,
  MANIFEST_FILE, OUTPUT_DIRECTORY } from './backup.mjs';
import { ENCRYPTED_DIRECTORY, ENCRYPTED_FILE, EncryptionError,
  checkConfig, execute, parseKey, runEncryption } from './encrypt-backup.mjs';

// Only fabricated fixtures; these are not credentials or customer data.
const key = 'abcdef0123456789'.repeat(4);
const bytes = Buffer.from('PGDMP-fabricated-test-private-database-content');
const privateDiagnostic = 'secret SOURCE_PASSWORD customer-row@example.invalid';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hasCode = (code) => (error) => error instanceof EncryptionError
  && error.code === code && error.message === code && !String(error).includes(privateDiagnostic);

async function fixture(t, changes = {}) {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'deluxe-encryption-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('deluxe-encryption-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const outputPath = path.join(directory, OUTPUT_DIRECTORY);
  await mkdir(outputPath, { mode: 0o700 });
  await chmod(outputPath, 0o700);
  const manifest = {
    manifestVersion: 1, database: EXPECTED_DATABASE, host: EXPECTED_HOST,
    archive: ARCHIVE_FILE, format: 'PostgreSQL custom', postgresMajor: 18,
    bytes: bytes.length, sha256: hash(bytes),
    verification: { magic: 'PGDMP', restoreList: true,
      requiredTableDefinitions: 13, requiredTableData: 13 },
    restoreCheck: { status: 'passed', checkedAt: '2026-11-26T00:00:00.000Z',
      postgresMajor: 18, requiredPublicTables: 13 }, ...changes,
  };
  const files = { [ARCHIVE_FILE]: bytes, [CHECKSUM_FILE]: `${hash(bytes)}  ${ARCHIVE_FILE}\n`,
    [MANIFEST_FILE]: JSON.stringify(manifest) };
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(path.join(outputPath, filename), content, { mode: 0o600 });
    await chmod(path.join(outputPath, filename), 0o600);
  }
  // Native Windows GnuPG also needs its ordinary OS paths; never inherit secrets.
  const osKeys = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT',
    'COMSPEC', 'HOME', 'USERPROFILE', 'TEMP', 'TMP'];
  const env = { ...Object.fromEntries(osKeys.filter((name) => typeof process.env[name] === 'string')
    .map((name) => [name, process.env[name]])), RUNNER_TEMP: directory,
    NEON_BACKUP_ENCRYPTION_KEY: key, NEON_BACKUP_DATABASE_URL: privateDiagnostic,
    GNUPGHOME: 'untrusted-home', TAR_OPTIONS: privateDiagnostic, UNRELATED_SECRET: privateDiagnostic };
  return { directory, outputPath, env, manifest };
}

function fakeTools({ tarFail = false, encryptionFail = false, decryptFail = false,
  corruptDecryption = false, gpgVersion = '2.4.7', onEncryption = async () => {},
} = {}) {
  const calls = [];
  const runProcess = async (command, args, options) => {
    calls.push({ command, args, options });
    for (const name of ['NEON_BACKUP_ENCRYPTION_KEY', 'NEON_BACKUP_DATABASE_URL', 'GNUPGHOME', 'TAR_OPTIONS', 'UNRELATED_SECRET']) {
      assert.equal(Object.hasOwn(options.env, name), false);
    }
    assert.equal(JSON.stringify(args).includes(key), false);
    assert.equal(JSON.stringify(args).includes(privateDiagnostic), false);
    if (args.includes('--version')) return { code: 0, stdout: command === 'gpg' ? `gpg (GnuPG) ${gpgVersion}\n` : 'tar version\n' };
    if (command === 'tar') {
      if (tarFail) return { code: 1, stdout: privateDiagnostic };
      const source = args[args.indexOf('--directory') + 1];
      const names = args.slice(args.indexOf('--') + 1);
      assert.deepEqual(names, [ARCHIVE_FILE, CHECKSUM_FILE, MANIFEST_FILE]);
      const contents = await Promise.all(names.map((name) => readFile(path.join(source, name))));
      const tar = Buffer.concat([Buffer.from('FAKE-TAR-UNIT-TEST-ONLY\n'), ...contents]);
      await writeFile(args[args.indexOf('--file') + 1], tar, { mode: 0o600 });
      return { code: 0 };
    }
    assert.equal(command, 'gpg');
    assert.equal(args[0], '--no-options');
    assert.ok(args.includes('--no-symkey-cache'));
    assert.ok(args.includes('--batch'));
    assert.deepEqual(args.slice(args.indexOf('--pinentry-mode'), args.indexOf('--pinentry-mode') + 2), ['--pinentry-mode', 'loopback']);
    assert.deepEqual(args.slice(args.indexOf('--passphrase-fd'), args.indexOf('--passphrase-fd') + 2), ['--passphrase-fd', '0']);
    assert.equal(options.input, `${key}\n`);
    const output = args[args.indexOf('--output') + 1];
    const input = await readFile(args.at(-1));
    if (args.includes('--symmetric')) {
      await onEncryption(args, options);
      assert.ok(args.includes('AES256'));
      assert.ok(args.includes('--force-mdc'));
      if (encryptionFail) return { code: 1, stdout: privateDiagnostic };
      // A reversible mock, not an encryption implementation or security claim.
      await writeFile(output, Buffer.concat([Buffer.from([0x8c]), Buffer.from(input.map((byte) => byte ^ 0x55))]), { mode: 0o600 });
    } else {
      assert.ok(args.includes('--decrypt'));
      if (decryptFail) throw new Error(privateDiagnostic);
      const plain = Buffer.from(input.subarray(1).map((byte) => byte ^ 0x55));
      if (corruptDecryption) plain[0] ^= 1;
      await writeFile(output, plain, { mode: 0o600 });
    }
    return { code: 0, stdout: privateDiagnostic };
  };
  return { calls, runProcess };
}

test('key format is strict, trims accidental outer whitespace and preserves case', () => {
  assert.equal(parseKey(` \r\n${key.toUpperCase()}\n`), key.toUpperCase());
  for (const value of [undefined, null, '', '   ']) assert.throws(() => parseKey(value), hasCode('KEY_MISSING'));
  for (const value of [key.slice(1), `${key}0`, 'z'.repeat(64), `${key.slice(0, 32)}\n${key.slice(32)}`]) {
    assert.throws(() => parseKey(value), hasCode('KEY_INVALID'));
  }
});

test('preflight rejects missing key before running tools', async () => {
  let calls = 0;
  await assert.rejects(checkConfig({ env: {}, runProcess: async () => { calls += 1; } }), hasCode('KEY_MISSING'));
  assert.equal(calls, 0);
});

test('preflight requires modern GnuPG and a usable tar, discarding diagnostics', async () => {
  const driver = fakeTools({ gpgVersion: '2.1.9' });
  await assert.rejects(checkConfig({ env: { NEON_BACKUP_ENCRYPTION_KEY: key }, runProcess: driver.runProcess }), hasCode('TOOLS_UNAVAILABLE'));
  await assert.rejects(checkConfig({ env: { NEON_BACKUP_ENCRYPTION_KEY: key }, runProcess: async () => { throw new Error(privateDiagnostic); } }), hasCode('TOOLS_UNAVAILABLE'));
});

test('packages all three verified files, verifies decryption, publishes ciphertext and checksum only, and removes staging', async (t) => {
  const { directory, outputPath, env } = await fixture(t);
  const driver = fakeTools();
  const result = await runEncryption({ env, runProcess: driver.runProcess });
  assert.equal(result.outputPath, path.join(directory, ENCRYPTED_DIRECTORY));
  assert.deepEqual((await readdir(result.outputPath)).sort(), [ENCRYPTED_FILE, CHECKSUM_FILE].sort());
  const ciphertext = await readFile(result.encryptedPath);
  assert.equal(ciphertext.includes(bytes), false);
  assert.equal(await readFile(path.join(result.outputPath, CHECKSUM_FILE), 'utf8'), `${hash(ciphertext)}  ${ENCRYPTED_FILE}\n`);
  assert.deepEqual((await readdir(directory)).sort(), [OUTPUT_DIRECTORY, ENCRYPTED_DIRECTORY].sort());
  assert.deepEqual(await readFile(path.join(outputPath, ARCHIVE_FILE)), bytes);
  assert.equal(driver.calls.filter((call) => call.args.includes('--symmetric')).length, 1);
  assert.equal(driver.calls.filter((call) => call.args.includes('--decrypt')).length, 1);
});

for (const [name, changes] of [
  ['failed restore', { restoreCheck: { status: 'failed' } }],
  ['missing restore', { restoreCheck: undefined }],
  ['wrong database', { database: 'unrelated' }],
  ['wrong host', { host: 'other.neon.tech' }],
  ['old PostgreSQL', { postgresMajor: 17 }],
  ['mismatched bytes', { bytes: 2 }],
  ['wrong checksum', { sha256: 'a'.repeat(64) }],
  ['missing table definitions', { verification: { magic: 'PGDMP', restoreList: true, requiredTableDefinitions: 12, requiredTableData: 13 } }],
]) {
  test(`refuses ${name} without encrypting or creating upload files`, async (t) => {
    const { directory, env } = await fixture(t, changes);
    const driver = fakeTools();
    await assert.rejects(runEncryption({ env, runProcess: driver.runProcess }), hasCode('EXPORT_INVALID'));
    assert.equal(driver.calls.some((call) => call.args.includes('--symmetric')), false);
    assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
  });
}

test('rejects changed archive bytes, bad checksum sidecar and unexpected source files', async (t) => {
  for (const kind of ['archive', 'checksum', 'extra']) {
    const { directory, outputPath, env } = await fixture(t);
    if (kind === 'archive') await writeFile(path.join(outputPath, ARCHIVE_FILE), Buffer.from('PGDMP-tampered'));
    if (kind === 'checksum') await writeFile(path.join(outputPath, CHECKSUM_FILE), 'bad');
    if (kind === 'extra') await writeFile(path.join(outputPath, 'pgpass'), 'not a real credential');
    await assert.rejects(runEncryption({ env, runProcess: fakeTools().runProcess }), hasCode('EXPORT_INVALID'));
    assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
  }
});

for (const [name, option, code] of [
  ['tar failure', 'tarFail', 'PACKAGING_FAILED'],
  ['encryption failure', 'encryptionFail', 'ENCRYPTION_FAILED'],
  ['decryption failure', 'decryptFail', 'DECRYPTION_CHECK_FAILED'],
  ['wrong decrypted bytes', 'corruptDecryption', 'DECRYPTION_CHECK_FAILED'],
]) {
  test(`${name} leaves no public artifact and cleans private staging`, async (t) => {
    const { directory, env } = await fixture(t);
    await assert.rejects(runEncryption({ env, runProcess: fakeTools({ [option]: true }).runProcess }), hasCode(code));
    assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
  });
}

test('refuses an existing upload directory without modifying its contents', async (t) => {
  const { directory, env } = await fixture(t);
  const upload = path.join(directory, ENCRYPTED_DIRECTORY);
  await mkdir(upload);
  await writeFile(path.join(upload, 'existing'), 'keep');
  await assert.rejects(runEncryption({ env, runProcess: fakeTools().runProcess }), hasCode('OUTPUT_EXISTS'));
  assert.equal(await readFile(path.join(upload, 'existing'), 'utf8'), 'keep');
});

test('refuses symlinked source files', async (t) => {
  const { directory, outputPath, env } = await fixture(t);
  const source = path.join(outputPath, ARCHIVE_FILE);
  await rm(source);
  const outside = path.join(directory, 'fixture-outside');
  await writeFile(outside, bytes);
  try { await symlink(outside, source); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Windows symbolic links require additional privileges'); return; } throw error; }
  await assert.rejects(runEncryption({ env, runProcess: fakeTools().runProcess }), hasCode('EXPORT_INVALID'));
  assert.deepEqual(await readFile(outside), bytes);
});

test('executor suppresses raw stdout/stderr and enforces bounded timeout', async () => {
  const result = await execute(process.execPath, ['-e', 'process.stdout.write("private"); process.stderr.write("private");'], { env: process.env });
  assert.deepEqual(result, { code: 0, stdout: '' });
  await assert.rejects(execute(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { env: process.env, timeoutMs: 20 }), hasCode('ENCRYPTION_FAILED'));
});

test('CLI prints a fixed failure code and never echoes the invalid key', () => {
  const result = spawnSync(process.execPath, ['scripts/encrypt-backup.mjs', '--check-config'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env: { ...process.env, NEON_BACKUP_ENCRYPTION_KEY: privateDiagnostic }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Backup encryption failed: KEY_INVALID\n');
});

test('real GnuPG/tar roundtrip for fabricated data only (explicit opt-in)', { skip: process.env.RUN_GPG_INTEGRATION !== '1' }, async (t) => {
  const { env } = await fixture(t);
  env.PATH = process.env.PATH || process.env.Path || '';
  // This diagnostic driver is test-only: its source data and key are fabricated.
  // Production execute() continues to suppress all raw program diagnostics.
  const nativeProcess = async (command, args, options) => {
    // Git for Windows ships an MSYS GnuPG which requires /c/... paths. Linux and
    // native Windows GnuPG keep the production arguments unchanged by default.
    const nativeArgs = command === 'gpg' && process.platform === 'win32'
      && process.env.TEST_GPG_MSYS_PATHS === '1'
      ? args.map((arg) => /^[a-z]:[\\/]/iu.test(arg)
        ? `/${arg[0].toLowerCase()}${arg.slice(2).replace(/\\/gu, '/')}` : arg)
      : args;
    const child = spawnSync(command, nativeArgs, { env: options.env, input: options.input,
      timeout: options.timeoutMs, maxBuffer: 65536, encoding: 'utf8', windowsHide: true });
    if (child.error || child.status !== 0) {
      const diagnostic = String(child.stderr || child.error?.message || 'native process failed')
        .replaceAll(key, '[SYNTHETIC KEY REDACTED]').slice(0, 4096);
      t.diagnostic(`Synthetic fixture ${command} diagnostic: ${diagnostic}`);
    }
    if (child.error) throw new Error('Synthetic native process failed');
    return { code: child.status, stdout: options.capture ? child.stdout : '' };
  };
  const result = await runEncryption({ env, runProcess: nativeProcess });
  const ciphertext = await readFile(result.encryptedPath);
  assert.equal(ciphertext.includes(bytes), false);
  assert.ok((await lstat(result.encryptedPath)).size > bytes.length);
});
