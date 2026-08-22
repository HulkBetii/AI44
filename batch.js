// Runs a signup pass and then the recovery passes, in the order their failure modes chain:
// a row stranded after signup is picked up by --resume; one whose stored password no longer
// opens the account needs --reset-password first, and --resume again afterwards.
//
// Which flag a row needs is fully determined by its sheet state, so there is nothing here a
// person has to decide - this just saves reading the sheet between passes.
//
//   node batch.js --limit=10
//
// Arguments are passed to the first pass only. The recovery passes deliberately take every
// stranded row, not just the ones this batch created.

const { spawn } = require('child_process');
const path = require('path');
const { withAutomationLock } = require('./automation-lock');

const SCRIPT = path.join(__dirname, 'signup-hotmail.js');

const firstPassArgs = process.argv.slice(2);
const PASSES = [
  { name: 'signup', args: firstPassArgs },
  { name: 'resume stranded rows', args: ['--resume'] },
  { name: 'reset rejected passwords', args: ['--reset-password'] },
  { name: 'resume after reset', args: ['--resume'] },
];

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: __dirname,
      stdio: 'inherit',
      env: { ...process.env, MAIL_TEMP_LOCK_HELD: '1' },
    });
    child.on('close', resolve);
    child.on('error', (err) => {
      console.error(`[batch] could not start pass: ${err.message}`);
      resolve(1);
    });
  });
}

withAutomationLock('batch-cli', async () => {
  for (const [i, pass] of PASSES.entries()) {
    console.log(`\n${'━'.repeat(64)}`);
    console.log(`▶ pass ${i + 1}/${PASSES.length}: ${pass.name}`);
    const displayArgs = pass.args.map((arg) => arg.startsWith('--proxy-token=')
      ? '--proxy-token=[REDACTED]'
      : arg);
    console.log(`  node signup-hotmail.js ${displayArgs.join(' ')}`.trimEnd());
    console.log('━'.repeat(64));

    // Per-account failures are handled inside the script and leave it exiting 0, so a
    // non-zero code here means something fatal - carrying on would only repeat it.
    const code = await run(pass.args);
    if (code !== 0) {
      console.error(`\n✖ pass "${pass.name}" exited with code ${code}. Stopping.`);
      process.exitCode = code;
      return;
    }
  }
  console.log(`\n${'━'.repeat(64)}`);
  console.log('✅ All passes finished. Check the sheet for any row still not complete.');
}).catch((err) => {
  console.error(`[batch] ${err.message}`);
  process.exitCode = 1;
});
