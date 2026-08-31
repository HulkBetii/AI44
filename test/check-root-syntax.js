const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const files = readdirSync(projectRoot)
  .filter((file) => file.endsWith('.js'))
  .sort();

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(projectRoot, file)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) failures.push({ file, output: `${result.stdout}${result.stderr}`.trim() });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`${failure.file}:\n${failure.output}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Syntax check passed for ${files.length} root JavaScript files.`);
}
