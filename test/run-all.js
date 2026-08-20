// Runs every suite in parallel. Sequential Chromium launches overrun a two-minute budget.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let failed = 0;
Promise.all(suites.map((file) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(__dirname, file)], { cwd: __dirname }, (err, stdout, stderr) => {
    const name = file.replace('.test.js', '');
    if (err) {
      failed++;
      console.log(`  ${name.padEnd(14)} FAIL`);
      console.log((stdout + stderr).split('\n').map((l) => '      ' + l).join('\n'));
    } else {
      console.log(`  ${name.padEnd(14)} PASS`);
    }
    resolve();
  });
}))).then(() => {
  console.log(failed ? `\n${failed} of ${suites.length} suites failed.` : `\nAll ${suites.length} suites passed.`);
  process.exitCode = failed ? 1 : 0;
});
