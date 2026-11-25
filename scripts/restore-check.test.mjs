import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ARCHIVE_FILE, EXPECTED_DATABASE, MANIFEST_FILE, OUTPUT_DIRECTORY, REQUIRED_TABLES,
  RestoreCheckError, execute, runRestoreCheck,
} from './restore-check.mjs';

// Entirely fabricated bytes and catalog metadata; no database or customer rows.
const archiveBytes = Buffer.from('PGDMP-fabricated-restore-unit-test-archive');
const containerId = 'a'.repeat(64);
const privateDiagnostic = 'private SQL row: customer@example.invalid; SOURCE_PASSWORD';

async function workspace(t, { archive = archiveBytes, manifest: changes = {} } = {}) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'deluxe-restore-test-'));
  t.after(async () => {
    // Delete only the specific temporary fixture created by this test.
    assert.equal(path.dirname(directory), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('deluxe-restore-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const outputPath = path.join(directory, OUTPUT_DIRECTORY);
  await mkdir(outputPath, { mode: 0o700 });
  await chmod(outputPath, 0o700);
  if (archive !== null) {
    await writeFile(path.join(outputPath, ARCHIVE_FILE), archive, { mode: 0o600 });
    await chmod(path.join(outputPath, ARCHIVE_FILE), 0o600);
  }
  const manifest = {
    manifestVersion: 1, createdAt: '2026-11-24T12:00:00.000Z',
    database: EXPECTED_DATABASE, archive: ARCHIVE_FILE, format: 'PostgreSQL custom',
    postgresMajor: 18, clientImage: 'postgres:18-bookworm', bytes: archiveBytes.length,
    sha256: createHash('sha256').update(archiveBytes).digest('hex'),
    verification: { magic: 'PGDMP', restoreList: true,
      requiredTableDefinitions: 13, requiredTableData: 13 }, ...changes,
  };
  await writeFile(path.join(outputPath, MANIFEST_FILE), JSON.stringify(manifest), { mode: 0o600 });
  await chmod(path.join(outputPath, MANIFEST_FILE), 0o600);
  return { directory, outputPath, manifest };
}

function env(directory, changes = {}) {
  return { RUNNER_TEMP: directory, PATH: process.env.PATH || process.env.Path || '',
    NEON_BACKUP_DATABASE_URL: 'postgresql://unused-secret-source',
    PGHOST: 'unused-live-source.invalid', PGPASSWORD: 'SOURCE_PASSWORD',
    DOCKER_HOST: 'tcp://untrusted-remote.invalid:2375', UNRELATED_SECRET: 'private', ...changes };
}

function fakeDocker({ launchExit = 0, launchThrows = false, stdoutId = containerId,
  cidId = containerId, ready = true, readyThrows = false, serverVersion = '180001',
  restoreExit = 0, restoreThrows = false, tables = REQUIRED_TABLES,
  schemaExit = 0, cleanupExit = 0, cleanupThrows = false,
  onRestore = async () => {}, onSchema = async () => {}, onCleanup = async () => {},
} = {}) {
  const calls = [];
  const runProcess = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, 'docker');
    for (const key of ['NEON_BACKUP_DATABASE_URL', 'PGHOST', 'PGPASSWORD', 'DOCKER_HOST', 'UNRELATED_SECRET']) {
      assert.equal(Object.hasOwn(options.env, key), false);
    }
    assert.equal(JSON.stringify(args).includes('SOURCE_PASSWORD'), false);
    if (args[0] === 'run') {
      const cidPath = args[args.indexOf('--cidfile') + 1];
      if (cidId !== null) await writeFile(cidPath, `${cidId}\n`, { mode: 0o600 });
      if (launchThrows) throw new Error(privateDiagnostic);
      return { code: launchExit, stdout: launchExit ? privateDiagnostic : `${stdoutId}\n` };
    }
    if (args[0] === 'rm') {
      assert.deepEqual(args, ['rm', '--force', '--volumes', cidId]);
      await onCleanup();
      if (cleanupThrows) throw new Error(privateDiagnostic);
      return { code: cleanupExit, stdout: privateDiagnostic };
    }
    assert.equal(args[0], 'exec');
    assert.deepEqual(args.slice(0, 4), ['exec', '--user', '0', containerId]);
    if (args.includes('pg_isready')) {
      assert.equal(args.includes('--no-password'), false);
      assert.ok(args.includes('--host=127.0.0.1'));
      assert.equal(args.includes('--host=/var/run/postgresql'), false);
      if (readyThrows) throw new Error(privateDiagnostic);
      return { code: ready ? 0 : 1, stdout: privateDiagnostic };
    }
    if (args.includes('pg_restore')) {
      await onRestore();
      if (restoreThrows) throw new Error(privateDiagnostic);
      return { code: restoreExit, stdout: privateDiagnostic };
    }
    assert.ok(args.includes('psql'));
    if (args.includes('--command=SHOW server_version_num;')) return { code: 0, stdout: `${serverVersion}\n` };
    const query = args.find((arg) => arg.startsWith('--command='));
    assert.ok(query.includes('pg_catalog.pg_class'));
    assert.ok(query.includes('pg_catalog.pg_namespace'));
    assert.equal(/SELECT\s+\*|COUNT\(|FROM\s+public\./iu.test(query), false);
    await onSchema();
    return { code: schemaExit, stdout: schemaExit ? privateDiagnostic : `${tables.join('\n')}\n` };
  };
  return { calls, runProcess };
}

function hasCode(code) {
  return (error) => error instanceof RestoreCheckError && error.code === code
    && error.message === code && !String(error).includes(privateDiagnostic);
}

async function manifestAt(outputPath) {
  return JSON.parse(await readFile(path.join(outputPath, MANIFEST_FILE), 'utf8'));
}

test('restores in its own isolated PG18 server, checks metadata, removes it, then marks the manifest passed', async (t) => {
  const { directory, outputPath, manifest } = await workspace(t);
  const originalArchive = await readFile(path.join(outputPath, ARCHIVE_FILE));
  const driver = fakeDocker({
    onRestore: async () => assert.equal(Object.hasOwn(await manifestAt(outputPath), 'restoreCheck'), false),
    onSchema: async () => assert.equal(Object.hasOwn(await manifestAt(outputPath), 'restoreCheck'), false),
    onCleanup: async () => assert.equal(Object.hasOwn(await manifestAt(outputPath), 'restoreCheck'), false),
  });
  // Source database configuration must not even be read by the restore checker.
  const guardedEnv = new Proxy(env(directory), { get(target, key) {
    assert.equal(['NEON_BACKUP_DATABASE_URL', 'PGHOST', 'PGPASSWORD'].includes(key), false);
    return target[key];
  } });
  const result = await runRestoreCheck({ env: guardedEnv, runProcess: driver.runProcess,
    now: () => new Date('2026-11-24T13:00:00Z') });
  const expected = { status: 'passed', checkedAt: '2026-11-24T13:00:00.000Z',
    postgresMajor: 18, requiredPublicTables: 13 };
  assert.deepEqual(result.restoreCheck, expected);
  assert.deepEqual(await manifestAt(outputPath), { ...manifest, restoreCheck: expected });
  assert.deepEqual(await readFile(path.join(outputPath, ARCHIVE_FILE)), originalArchive);
  assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
  assert.deepEqual((await readdir(outputPath)).sort(), [ARCHIVE_FILE, MANIFEST_FILE].sort());
  const start = driver.calls[0].args;
  assert.equal(start[start.indexOf('--network') + 1], 'none');
  assert.equal(start[start.indexOf('--memory') + 1], '512m');
  assert.equal(start[start.indexOf('--cpus') + 1], '1');
  assert.equal(start[start.indexOf('--pids-limit') + 1], '256');
  assert.ok(start.includes('--rm'));
  assert.ok(start.includes('--detach'));
  assert.ok(start.includes(`type=bind,src=${outputPath},dst=/backup,readonly`));
  assert.ok(start.includes(`POSTGRES_DB=${EXPECTED_DATABASE}`));
  assert.ok(start.includes('POSTGRES_HOST_AUTH_METHOD=trust'));
  assert.equal(start.at(-1), 'postgres:18-bookworm');
  assert.equal(start.includes('--user'), false); // Official entrypoint initializes as root.
  assert.equal(start.some((arg) => ['-p', '-P', '--publish', '--publish-all'].includes(arg)
    || arg.startsWith('--publish=')), false);
  const cidPath = start[start.indexOf('--cidfile') + 1];
  assert.equal(path.dirname(path.dirname(cidPath)), directory);
  await assert.rejects(lstat(path.dirname(cidPath)), { code: 'ENOENT' });
  const restore = driver.calls.find((call) => call.args.includes('pg_restore'));
  assert.equal(restore.options.capture, undefined);
  for (const flag of ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', '--no-tablespaces']) {
    assert.ok(restore.args.includes(flag));
  }
  assert.ok(restore.args.includes(`--dbname=${EXPECTED_DATABASE}`));
  assert.ok(restore.args.includes('--host=/var/run/postgresql'));
  assert.equal(restore.args.at(-1), `/backup/${ARCHIVE_FILE}`);
  const readiness = driver.calls.find((call) => call.args.includes('pg_isready'));
  // A Unix-socket probe would accept the image's temporary initialization server
  // before the target database exists; probe the final server over loopback TCP.
  assert.ok(readiness.args.includes('--host=127.0.0.1'));
  assert.equal(readiness.args.includes('--host=/var/run/postgresql'), false);
  assert.deepEqual(driver.calls.at(-1).args, ['rm', '--force', '--volumes', containerId]);
  if (process.platform === 'linux') assert.equal((await lstat(path.join(outputPath, MANIFEST_FILE))).mode & 0o777, 0o600);
});

test('failed restore, schema, server version and cleanup never produce a pass and always attempt owned cleanup', async (t) => {
  for (const [changes, code] of [
    [{ restoreExit: 1 }, 'RESTORE_FAILED'], [{ restoreThrows: true }, 'RESTORE_FAILED'],
    [{ tables: REQUIRED_TABLES.slice(1) }, 'SCHEMA_CHECK_FAILED'],
    [{ tables: [...REQUIRED_TABLES, 'private diagnostic'] }, 'SCHEMA_CHECK_FAILED'],
    [{ tables: [...REQUIRED_TABLES.slice(1), REQUIRED_TABLES[1]] }, 'SCHEMA_CHECK_FAILED'],
    [{ schemaExit: 1 }, 'SCHEMA_CHECK_FAILED'],
    [{ serverVersion: '170010' }, 'SERVER_VERSION_MISMATCH'],
    [{ serverVersion: privateDiagnostic }, 'SERVER_VERSION_MISMATCH'],
    [{ cleanupExit: 1 }, 'CLEANUP_FAILED'], [{ cleanupThrows: true }, 'CLEANUP_FAILED'],
  ]) {
    await t.test(code + ' ' + Object.keys(changes).join(','), async (subtest) => {
      const { directory, outputPath } = await workspace(subtest);
      const driver = fakeDocker(changes);
      await assert.rejects(runRestoreCheck({ env: env(directory), runProcess: driver.runProcess }), hasCode(code));
      assert.equal(Object.hasOwn(await manifestAt(outputPath), 'restoreCheck'), false);
      assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
      assert.deepEqual(driver.calls.at(-1).args, ['rm', '--force', '--volumes', containerId]);
      assert.equal(driver.calls.filter((call) => call.args[0] === 'rm').length, 1);
      if (code === 'SERVER_VERSION_MISMATCH') assert.equal(driver.calls.some((call) => call.args.includes('pg_restore')), false);
    });
  }
});

test('readiness has a 60 second maximum and removes the owned container on timeout', async (t) => {
  for (const readyThrows of [false, true]) {
    const { directory, outputPath } = await workspace(t);
    const driver = fakeDocker({ ready: false, readyThrows });
    let elapsed = 0;
    await assert.rejects(runRestoreCheck({ env: env(directory), runProcess: driver.runProcess,
      clock: () => elapsed, sleep: async (milliseconds) => { elapsed += milliseconds; },
    }), hasCode('READY_TIMEOUT'));
    assert.equal(elapsed, 60000);
    const polls = driver.calls.filter((call) => call.args.includes('pg_isready'));
    assert.equal(polls.length, 60);
    assert.ok(polls.every((call) => call.options.timeoutMs <= 2000));
    assert.equal(driver.calls.some((call) => call.args.includes('pg_restore')), false);
    assert.deepEqual(driver.calls.at(-1).args, ['rm', '--force', '--volumes', containerId]);
    assert.equal(Object.hasOwn(await manifestAt(outputPath), 'restoreCheck'), false);
    assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
  }
});

test('launch failures recover the owned ID from cidfile and never enumerate other containers', async (t) => {
  for (const changes of [{ launchExit: 1 }, { launchThrows: true }, { stdoutId: privateDiagnostic }]) {
    const { directory, outputPath } = await workspace(t);
    const driver = fakeDocker(changes);
    const code = changes.stdoutId ? 'CONTAINER_ID_INVALID' : 'CONTAINER_START_FAILED';
    await assert.rejects(runRestoreCheck({ env: env(directory), runProcess: driver.runProcess }), hasCode(code));
    assert.equal(driver.calls.length, 2);
    assert.deepEqual(driver.calls.at(-1).args, ['rm', '--force', '--volumes', containerId]);
    assert.equal(Object.hasOwn(await manifestAt(outputPath), 'restoreCheck'), false);
    assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
  }
});

test('unsafe or absent cidfile IDs are never passed to Docker removal', async (t) => {
  for (const cidId of [null, 'another-container', `${containerId}\n${'b'.repeat(64)}`, `--force ${containerId}`]) {
    const { directory } = await workspace(t);
    const driver = fakeDocker({ cidId });
    await assert.rejects(runRestoreCheck({ env: env(directory), runProcess: driver.runProcess }), hasCode('CONTAINER_ID_INVALID'));
    assert.equal(driver.calls.length, 1);
    assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
  }
});

test('missing, corrupt or mismatched exports fail before starting Docker', async (t) => {
  for (const [changes, code] of [
    [{ archive: null }, 'ARCHIVE_INVALID'], [{ archive: Buffer.from('plain SQL') }, 'ARCHIVE_INVALID'],
    [{ archive: Buffer.from('PGDMP-corrupted-archive') }, 'ARCHIVE_MISMATCH'],
    [{ manifest: { database: 'different_database' } }, 'MANIFEST_INVALID'],
    [{ manifest: { sha256: 'invalid' } }, 'MANIFEST_INVALID'],
    [{ manifest: { verification: { restoreList: false } } }, 'MANIFEST_INVALID'],
  ]) {
    await t.test(code + ' ' + Object.keys(changes).join(','), async (subtest) => {
      const { directory, outputPath } = await workspace(subtest, changes);
      const driver = fakeDocker();
      await assert.rejects(runRestoreCheck({ env: env(directory), runProcess: driver.runProcess }), hasCode(code));
      assert.equal(driver.calls.length, 0);
      assert.equal(Object.hasOwn(await manifestAt(outputPath), 'restoreCheck'), false);
      assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
    });
  }
});

test('unsafe contexts, wrong targets and nonofficial images fail before Docker', async (t) => {
  const { directory } = await workspace(t);
  for (const [changes, code] of [
    [{ RUNNER_TEMP: '' }, 'TEMP_CONTEXT_INVALID'], [{ RUNNER_TEMP: 'relative' }, 'TEMP_CONTEXT_INVALID'],
    [{ RUNNER_TEMP: path.parse(directory).root }, 'TEMP_CONTEXT_INVALID'],
    [{ POSTGRES_IMAGE: 'attacker/postgres:18-bookworm' }, 'IMAGE_INVALID'],
    [{ POSTGRES_IMAGE: 'postgres:17-bookworm' }, 'IMAGE_INVALID'],
    [{ EXPECTED_DATABASE: 'another_database' }, 'TARGET_MISMATCH'],
  ]) {
    const driver = fakeDocker();
    await assert.rejects(runRestoreCheck({ env: env(directory, changes), runProcess: driver.runProcess }), hasCode(code));
    assert.equal(driver.calls.length, 0);
  }
});

test('symlinked output is rejected without touching its target', async (t) => {
  const { directory, outputPath } = await workspace(t);
  await rm(outputPath, { recursive: true });
  const target = path.join(directory, 'keep-target');
  await mkdir(target);
  await writeFile(path.join(target, 'keep'), 'keep');
  try {
    await symlink(target, outputPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('This Windows host does not permit creating directory links; Linux CI exercises this case.');
    return;
  }
  const driver = fakeDocker();
  await assert.rejects(runRestoreCheck({ env: env(directory), runProcess: driver.runProcess }), hasCode('TEMP_CONTEXT_INVALID'));
  assert.equal(driver.calls.length, 0);
  assert.equal(await readFile(path.join(target, 'keep'), 'utf8'), 'keep');
});

test('rerunning a previously passed check removes its stale pass before a failed restore', async (t) => {
  const { directory, outputPath } = await workspace(t, { manifest: { restoreCheck: { status: 'passed' } } });
  const driver = fakeDocker({ restoreExit: 1,
    onRestore: async () => assert.equal(Object.hasOwn(await manifestAt(outputPath), 'restoreCheck'), false),
  });
  await assert.rejects(runRestoreCheck({ env: env(directory), runProcess: driver.runProcess }), hasCode('RESTORE_FAILED'));
  assert.equal(Object.hasOwn(await manifestAt(outputPath), 'restoreCheck'), false);
  assert.deepEqual(await readdir(directory), [OUTPUT_DIRECTORY]);
});

test('process execution suppresses raw stderr and uncaptured stdout, and sanitizes timeout failures', async () => {
  const result = await execute(process.execPath, ['-e',
    `process.stdout.write(${JSON.stringify(privateDiagnostic)}); process.stderr.write(${JSON.stringify(privateDiagnostic)}); process.exitCode = 7;`],
  { env: {}, capture: false });
  assert.deepEqual(result, { code: 7, stdout: '' });
  await assert.rejects(execute(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
    env: {}, timeoutMs: 20,
  }), hasCode('PROCESS_FAILED'));
});

test('CLI exposes only a fixed error code with private job settings present', () => {
  const executable = fileURLToPath(new URL('./restore-check.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [executable], { encoding: 'utf8', env: {
    ...process.env, RUNNER_TEMP: '', NEON_BACKUP_DATABASE_URL: privateDiagnostic,
  } });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'Isolated restore check failed: TEMP_CONTEXT_INVALID\n');
  assert.equal(child.stderr.includes(privateDiagnostic), false);
});
