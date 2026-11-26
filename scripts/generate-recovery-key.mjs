import { randomBytes } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Save outside this repository and never print the recovery key in logs.
try {
  const requested = process.argv[2];
  if (process.argv.length !== 3 || !requested || !path.isAbsolute(requested)) {
    throw new Error('OUTPUT_PATH_REQUIRED');
  }
  const repository = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const parent = await realpath(path.dirname(requested));
  const destination = path.join(parent, path.basename(requested));
  const relative = path.relative(repository, destination);
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..'
      && !relative.startsWith(`..${path.sep}`))) throw new Error('OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
  await writeFile(destination, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Recovery key saved locally outside the repository. No key value was printed.');
} catch {
  console.error('Recovery key was not created. Use a new absolute file path outside the repository, in an existing private folder. Existing files are never overwritten.');
  process.exitCode = 1;
}
