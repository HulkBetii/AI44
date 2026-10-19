/**
 * export-keys.js
 * Export captured ElevenLabs API keys / Bearer tokens from Google Sheet
 * separated by ' , '.
 * Supports --last=N and --out=filename.
 */

const fs = require('fs');
const path = require('path');
const { initSignupSheets, loadRows } = require('./sheets');

function parseArgs(argv) {
  let last = null;
  let out = 'catch-all-keys.txt';
  let sep = ',';
  let format = null;

  for (const arg of argv) {
    if (arg.startsWith('--last=')) {
      last = parseInt(arg.split('=')[1], 10) || null;
    }
    if (arg.startsWith('--out=')) {
      out = arg.split('=')[1].trim();
    }
    if (arg.startsWith('--sep=')) {
      sep = arg.slice(6);
    }
    if (arg.startsWith('--format=')) {
      format = arg.split('=')[1].trim().toLowerCase();
    }
  }
  return { last, out, sep, format };
}

async function exportKeys(options = {}) {
  const { last = null, out = 'catch-all-keys.txt', sep = ',', format = null } = options;
  const targetPath = path.isAbsolute(out) ? out : path.join(__dirname, '..', out);

  await initSignupSheets();
  const rows = await loadRows();
  let validKeys = rows
    .map((r) => (r.apiKey || '').trim())
    .filter((k) => k.length > 20);

  if (last !== null && last > 0) {
    validKeys = validKeys.slice(-last);
  }

  console.log(`[export] Exporting ${validKeys.length} key(s) to ${targetPath} (format: ${format || sep})...`);

  let content;
  if (format === 'lines' || sep === 'line-comma') {
    // Format: key [space] , [newline] key tiếp theo...
    content = validKeys.map((k) => `${k} ,`).join('\n') + '\n';
  } else {
    content = validKeys.join(sep);
  }

  fs.writeFileSync(targetPath, content, 'utf8');
  console.log(`[export] Successfully exported ${validKeys.length} keys to ${targetPath}`);
  return { count: validKeys.length, targetPath };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  exportKeys(args).catch((err) => {
    console.error('[export] Error:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { exportKeys };

