import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ARCHIVE_FILE, CHECKSUM_FILE, MANIFEST_FILE, OUTPUT_DIRECTORY,
  EXPECTED_DATABASE, EXPECTED_HOST, REQUIRED_TABLES, BackupError,
  connectionEnvironment, dockerArguments, escapePgpass, execute, parseDatabaseUrl,
  pgpassLine, runBackup, validateArchiveToc,
} from './backup.mjs';

// Fabricated metadata and bytes only: these fixtures contain no production rows.
const password = 'private:pass\\word@with punctuation';
const username = 'backup:role\\name';
const uri = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${EXPECTED_HOST}:5432/${EXPECTED_DATABASE}?sslmode=require&channel_binding=require`;
const archiveBytes = Buffer.from('PGDMP-fabricated-unit-test-archive');
const toc = [
  '; Archive created for unit tests', `;     dbname: ${EXPECTED_DATABASE}`,
  ';     Dumped from database version: 18.0', ';     Dumped by pg_dump version: 18.1',
  ...REQUIRED_TABLES.flatMap((table, index) => [
    `${100 + index}; 1259 ${200 + index} TABLE public ${table} test_owner`,
    `${300 + index}; 0 ${200 + index} TABLE DATA public ${table} test_owner`,
  ]),
].join('\n');

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deluxe-backup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function testEnv(directory, extra = {}) {
  return { NEON_BACKUP_DATABASE_URL: uri, RUNNER_TEMP: directory,
    PATH: process.env.PATH || process.env.Path || '', UNRELATED_SECRET: 'should-not-propagate', ...extra };
}

function fakeDocker({ archive = archiveBytes, metadata = toc, rejectStep,
  dumpExit = 0, restoreExit = 0, dumpVersion = '18.1', restoreVersion = '18.1',
  onDump = async () => {}, onVersion = async () => {},
} = {}) {
  const calls = [];
  const runProcess = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, 'docker');
    assert.equal(JSON.stringify({ args, env: options.env }).includes(uri), false);
    assert.equal(JSON.stringify({ args, env: options.env }).includes(password), false);
    assert.equal(Object.hasOwn(options.env, 'NEON_BACKUP_DATABASE_URL'), false);
    assert.equal(Object.hasOwn(options.env, 'UNRELATED_SECRET'), false);
    assert.equal(Object.hasOwn(options.env, 'PGPASSWORD'), false);
    const program = args.includes('pg_dump') ? 'pg_dump' : 'pg_restore';
    const version = args.includes('--version');
    const step = version ? `${program}_version` : program;
    if (rejectStep === step) throw new Error(`${uri} leaked driver diagnostic ${password}`);
    if (version) {
      await onVersion({ args, options });
      return { code: 0, stdout: `${program} (PostgreSQL) ${program === 'pg_dump' ? dumpVersion : restoreVersion} (Debian)\n` };
    }
    if (program === 'pg_dump') {
      const outputMount = args.find((argument) => argument.startsWith('type=bind,src=')
        && argument.endsWith(',dst=/backup'));
      const outputPath = outputMount.slice('type=bind,src='.length, -',dst=/backup'.length);
      const passMount = args.find((argument) => argument.endsWith(',dst=/run/secrets/pgpass,readonly'));
      const pgpassPath = passMount.slice('type=bind,src='.length, -',dst=/run/secrets/pgpass,readonly'.length);
      await onDump({ args, options, outputPath, pgpassPath });
      if (archive !== null) await writeFile(path.join(outputPath, ARCHIVE_FILE), archive);
      return { code: dumpExit, stdout: `${uri} private pg_dump diagnostic ${password}` };
    }
    return { code: restoreExit, stdout: restoreExit ? `${uri} private restore error ${password}` : metadata };
  };
  return { calls, runProcess };
}

function hasCode(code) {
  return (error) => error instanceof BackupError && error.code === code
    && error.message === code && !String(error).includes(password) && !String(error).includes(uri);
}

test('URL credentials are decoded privately and TLS is strengthened independently of URI settings', () => {
  const config = parseDatabaseUrl(uri);
  assert.equal(config.password, password);
  assert.equal(config.username, username);
  assert.deepEqual(connectionEnvironment(config), {
    PGHOST: EXPECTED_HOST, PGPORT: '5432', PGDATABASE: EXPECTED_DATABASE, PGUSER: username,
    PGSSLMODE: 'verify-full', PGSSLROOTCERT: 'system', PGCHANNELBINDING: 'require',
    PGCONNECT_TIMEOUT: '30', PGPASSFILE: '/run/secrets/pgpass',
  });
  assert.equal(escapePgpass('a:b\\c'), 'a\\:b\\\\c');
  assert.equal(pgpassLine(config),
    `${EXPECTED_HOST}:5432:${EXPECTED_DATABASE}:backup\\:role\\\\name:private\\:pass\\\\word@with punctuation\n`);
  assert.equal(parseDatabaseUrl(uri.replace('postgresql:', 'postgres:')).database, EXPECTED_DATABASE);
  assert.equal(parseDatabaseUrl(uri + '&connect_timeout=10&sslrootcert=system').host, EXPECTED_HOST);
});

test('URL validation rejects target changes, pooling, incomplete credentials, unsafe options and malformed input', () => {
  const cases = [
    [undefined, 'CONFIG_MISSING'], ['', 'CONFIG_MISSING'],
    [uri.replace(EXPECTED_DATABASE, 'other_database'), 'TARGET_MISMATCH'],
    [uri.replace(EXPECTED_HOST, 'other.neon.tech'), 'TARGET_MISMATCH'],
    [uri.replace(EXPECTED_HOST, EXPECTED_HOST.replace('.c-5', '-pooler.c-5')), 'TARGET_MISMATCH'],
    [uri.replace(':5432/', ':5433/'), 'TARGET_MISMATCH'],
    [uri.replace('postgresql:', 'https:'), 'DATABASE_URL_INVALID'],
    [`postgresql://:${encodeURIComponent(password)}@${EXPECTED_HOST}/${EXPECTED_DATABASE}`, 'DATABASE_URL_INVALID'],
    [`postgresql://user@${EXPECTED_HOST}/${EXPECTED_DATABASE}`, 'DATABASE_URL_INVALID'],
    [uri + '#fragment', 'DATABASE_URL_INVALID'], [uri + '#', 'DATABASE_URL_INVALID'],
    [uri + '\n', 'DATABASE_URL_INVALID'], [uri.replace('private', '%0aprivate'), 'DATABASE_URL_INVALID'],
    [uri.replace('private', '%FFprivate'), 'DATABASE_URL_INVALID'],
    [uri.replace('private', '%zzprivate'), 'DATABASE_URL_INVALID'],
    [uri + '&application_name=do-not-allow', 'TLS_OPTIONS_INVALID'],
    [uri + '&options=-csearch_path%3Dpublic', 'TLS_OPTIONS_INVALID'],
    [uri + '&sslmode=verify-full', 'TLS_OPTIONS_INVALID'],
    [uri.replace('sslmode=require', 'sslmode=disable'), 'TLS_OPTIONS_INVALID'],
    [uri + '&sslrootcert=%2Fetc%2Fcustom-cert', 'TLS_OPTIONS_INVALID'],
    [uri + '&connect_timeout=0', 'TLS_OPTIONS_INVALID'],
    [uri + '&connect_timeout=%ff', 'DATABASE_URL_INVALID'],
    [uri.replace(EXPECTED_DATABASE, `${EXPECTED_DATABASE}%2Fextra`), 'TARGET_MISMATCH'],
  ];
  for (const [value, code] of cases) assert.throws(() => parseDatabaseUrl(value), hasCode(code));
  assert.throws(() => escapePgpass('password\nline'), hasCode('DATABASE_URL_INVALID'));
});

test('TOC verification requires definitions and data for every core table and accepts additional tables', () => {
  assert.deepEqual(validateArchiveToc(toc), { requiredTableDefinitions: 13, requiredTableData: 13 });
  assert.doesNotThrow(() => validateArchiveToc(toc + '\n900; 1259 901 TABLE public future_table owner\n902; 0 901 TABLE DATA public future_table owner'));
  for (const metadata of [
    toc.replace(/^.*TABLE DATA public users.*$/mu, ''),
    toc.replace(/^.*TABLE public users.*$/mu, ''),
    toc.replaceAll('public users ', 'private users '),
    toc.replace('database version: 18.0', 'database version: 17.9'),
    toc.replace('pg_dump version: 18.1', 'pg_dump version: 19.0'),
    toc.replace(`dbname: ${EXPECTED_DATABASE}`, 'dbname: another_database'),
    '',
  ]) assert.throws(() => validateArchiveToc(metadata), hasCode('ARCHIVE_CONTENTS_INVALID'));
});

test('Linux containers use host identity, a read-only root, and no shell or password arguments', () => {
  const args = dockerArguments({ image: 'postgres:18-bookworm', platform: 'linux', uid: 1001, gid: 1002,
    outputPath: '/private/output', pgpassPath: '/private/pgpass', connection: parseDatabaseUrl(uri), network: 'bridge' });
  assert.equal(args[args.indexOf('--user') + 1], '1001:1002');
  assert.equal(args[args.indexOf('--network') + 1], 'bridge');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('HOME=/tmp'));
  assert.ok(args.includes('type=bind,src=/private/pgpass,dst=/run/secrets/pgpass,readonly'));
  assert.equal(args.some((value) => value.includes(password) || value.includes(uri)), false);
  assert.throws(() => dockerArguments({ image: 'postgres:18-bookworm', platform: 'linux' }), hasCode('TEMP_CONTEXT_INVALID'));
});

test('process driver discards diagnostics and replaces process errors with a fixed code', async () => {
  const script = 'process.stdout.write("private-output"); process.stderr.write("private-diagnostic");';
  assert.deepEqual(await execute(process.execPath, ['-e', script], { env: {}, capture: false }),
    { code: 0, stdout: '' });
  assert.deepEqual(await execute(process.execPath, ['-e', script], { env: {}, capture: true }),
    { code: 0, stdout: 'private-output' });
  await assert.rejects(execute('nonexistent-deluxe-backup-program', [], { env: {} }), hasCode('DOCKER_FAILED'));
});

test('successful backup publishes exactly three verified files and deletes all private staging files', async (t) => {
  const directory = await workspace(t);
  let privatePath;
  const driver = fakeDocker({ onDump: async ({ args, pgpassPath, outputPath }) => {
    privatePath = path.dirname(pgpassPath);
    assert.equal(await readFile(pgpassPath, 'utf8'), pgpassLine(parseDatabaseUrl(uri)));
    assert.ok(args.includes('--format=custom'));
    assert.ok(args.includes('--compress=gzip:9'));
    assert.ok(args.includes('--no-password'));
    assert.equal(args.some((value) => value.startsWith('--table') || value.includes('schema-only')), false);
    if (process.platform === 'linux') {
      assert.equal((await lstat(pgpassPath)).mode & 0o777, 0o600);
      assert.equal((await lstat(privatePath)).mode & 0o777, 0o700);
      assert.equal((await lstat(outputPath)).mode & 0o777, 0o700);
    }
  } });
  const result = await runBackup({ env: testEnv(directory), runProcess: driver.runProcess,
    now: () => new Date('2026-11-24T12:34:56Z') });
  assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
  assert.deepEqual((await readdir(result.outputPath)).sort(), [ARCHIVE_FILE, CHECKSUM_FILE, MANIFEST_FILE].sort());
  await assert.rejects(lstat(privatePath), { code: 'ENOENT' });
  assert.deepEqual(await readFile(result.archivePath), archiveBytes);
  const sha256 = createHash('sha256').update(archiveBytes).digest('hex');
  assert.equal(await readFile(path.join(result.outputPath, CHECKSUM_FILE), 'utf8'), `${sha256}  ${ARCHIVE_FILE}\n`);
  const manifestText = await readFile(path.join(result.outputPath, MANIFEST_FILE), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.sha256, sha256);
  assert.equal(manifest.bytes, archiveBytes.length);
  assert.equal(manifest.createdAt, '2026-11-24T12:34:56.000Z');
  for (const secret of [uri, password, username, 'test_owner']) assert.equal(manifestText.includes(secret), false);
  if (process.platform === 'linux') {
    assert.equal((await lstat(result.outputPath)).mode & 0o777, 0o700);
    for (const filename of [ARCHIVE_FILE, CHECKSUM_FILE, MANIFEST_FILE]) {
      assert.equal((await lstat(path.join(result.outputPath, filename))).mode & 0o777, 0o600);
    }
  }
  assert.equal(driver.calls.length, 4);
  const restoreCall = driver.calls[3];
  assert.ok(restoreCall.args.includes(`type=bind,src=${path.join(privatePath, 'output')},dst=/backup,readonly`));
  assert.equal(restoreCall.args[restoreCall.args.indexOf('--network') + 1], 'none');
  assert.equal(restoreCall.args.some((value) => value.includes('pgpass')), false);
});

test('existing output is preserved without running Docker or overwriting files', async (t) => {
  const directory = await workspace(t);
  const outputPath = path.join(directory, OUTPUT_DIRECTORY);
  await mkdir(outputPath);
  await writeFile(path.join(outputPath, ARCHIVE_FILE), 'existing');
  const driver = fakeDocker();
  await assert.rejects(runBackup({ env: testEnv(directory), runProcess: driver.runProcess }), hasCode('OUTPUT_EXISTS'));
  assert.equal(await readFile(path.join(outputPath, ARCHIVE_FILE), 'utf8'), 'existing');
  assert.equal(driver.calls.length, 0);
});

test('all command and validation failures remove staging and partial output while hiding driver diagnostics', async (t) => {
  const cases = [
    [{ rejectStep: 'pg_dump_version' }, 'DOCKER_FAILED'],
    [{ dumpVersion: '17.6' }, 'CLIENT_VERSION_MISMATCH'],
    [{ restoreVersion: '19.0' }, 'CLIENT_VERSION_MISMATCH'],
    [{ rejectStep: 'pg_dump' }, 'DUMP_FAILED'],
    [{ dumpExit: 1 }, 'DUMP_FAILED'],
    [{ archive: null }, 'ARCHIVE_INVALID'],
    [{ archive: Buffer.alloc(0) }, 'ARCHIVE_INVALID'],
    [{ archive: Buffer.from('plain SQL must not upload') }, 'ARCHIVE_INVALID'],
    [{ archive: Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(1024 * 1024)]) }, 'ARCHIVE_TOO_LARGE'],
    [{ restoreExit: 1 }, 'RESTORE_LIST_FAILED'],
    [{ rejectStep: 'pg_restore' }, 'RESTORE_LIST_FAILED'],
    [{ metadata: toc.replace(/^.*TABLE DATA public users.*$/mu, '') }, 'ARCHIVE_CONTENTS_INVALID'],
  ];
  for (const [options, code] of cases) {
    await t.test(code + ' ' + JSON.stringify(Object.keys(options)), async (subtest) => {
      const directory = await workspace(subtest);
      const driver = fakeDocker(options);
      await assert.rejects(runBackup({ env: testEnv(directory, { MAX_BACKUP_MIB: '1' }), runProcess: driver.runProcess }), hasCode(code));
      assert.deepEqual(await readdir(directory), []);
    });
  }
});

test('context validation fails before Docker for missing temp, untrusted image, target overrides and invalid size', async (t) => {
  const directory = await workspace(t);
  for (const [extra, code] of [
    [{ RUNNER_TEMP: '' }, 'TEMP_CONTEXT_INVALID'],
    [{ RUNNER_TEMP: 'relative/path' }, 'TEMP_CONTEXT_INVALID'],
    [{ RUNNER_TEMP: path.join(directory, 'absent') }, 'TEMP_CONTEXT_INVALID'],
    [{ POSTGRES_IMAGE: 'attacker/postgres:18-bookworm' }, 'IMAGE_INVALID'],
    [{ POSTGRES_IMAGE: 'postgres:17-bookworm' }, 'IMAGE_INVALID'],
    [{ EXPECTED_DATABASE: 'wrong_database' }, 'TARGET_MISMATCH'],
    [{ EXPECTED_HOST: 'other.neon.tech' }, 'TARGET_MISMATCH'],
    [{ MAX_BACKUP_MIB: '0' }, 'CONFIG_MISSING'],
    [{ MAX_BACKUP_MIB: '1.5' }, 'CONFIG_MISSING'],
  ]) {
    const driver = fakeDocker();
    await assert.rejects(runBackup({ env: testEnv(directory, extra), runProcess: driver.runProcess }), hasCode(code));
    assert.equal(driver.calls.length, 0);
    assert.deepEqual(await readdir(directory), []);
  }
});

test('a symlinked output directory is rejected and its target is preserved', async (t) => {
  const directory = await workspace(t);
  const target = path.join(directory, 'target');
  await mkdir(target);
  await writeFile(path.join(target, 'keep'), 'keep');
  try {
    await symlink(target, path.join(directory, OUTPUT_DIRECTORY), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('This environment does not allow creating symlinks.');
      return;
    }
    throw error;
  }
  const driver = fakeDocker();
  await assert.rejects(runBackup({ env: testEnv(directory), runProcess: driver.runProcess }), hasCode('OUTPUT_EXISTS'));
  assert.equal(await readFile(path.join(target, 'keep'), 'utf8'), 'keep');
  assert.equal(driver.calls.length, 0);
});

test('CLI emits only a fixed failure code when a secret URL is invalid', () => {
  const executable = fileURLToPath(new URL('./backup.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [executable], { encoding: 'utf8',
    env: { ...process.env, NEON_BACKUP_DATABASE_URL: uri + '#secret-fragment' } });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'Backup failed: DATABASE_URL_INVALID\n');
  assert.equal(child.stderr.includes(password), false);
  assert.equal(child.stderr.includes(uri), false);
});
