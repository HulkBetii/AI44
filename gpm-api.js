const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadRuntimeConfig } = require('./runtime-config');

// GPM assigns this port per installation - its own docs tell you to read it from the app's
// API tab, and their examples show 19955 and 50615. 19995 is correct on this machine, so it
// stays the default, but hardcoding it outright would break silently anywhere else.
const runtimeConfig = loadRuntimeConfig();
const API_BASE = runtimeConfig.gpmApiBase;
const GPM_CREATE_UNCERTAIN = 'GPM_CREATE_UNCERTAIN';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uncertainDirectory({ runtimeDirectory = runtimeConfig.runtimeDirectory } = {}) {
  return path.join(runtimeDirectory, 'gpm-create-uncertain');
}

function validateRecoveryId(id) {
  if (!UUID_V4.test(String(id || ''))) throw new Error('Invalid uncertain GPM create id');
  return id;
}

function uncertainPath(id, options = {}) {
  return path.join(uncertainDirectory(options), `${validateRecoveryId(id)}.json`);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let renamed = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}

function isMissingProfileResponse(response) {
  const message = String(response?.message || response?.raw || '');
  return /not found|does not exist|không (?:tồn tại|tìm thấy)/i.test(message);
}

function callApi(endpoint, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${API_BASE}${endpoint}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          // Xử lý các endpoint trả về chữ 'OK' hoặc chuỗi không phải JSON
          if (data.trim() === 'OK') {
            resolve({ status: true, message: 'OK' });
            return;
          }
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          resolve({ status: false, raw: data }); // Trả về raw text nếu không parse được
        }
      });
    }).on('error', (e) => {
      reject(new Error(`Failed to call GPM API: ${e.message}`));
    });

    // http.get applies no timeout of its own. These calls sit at the top of every account
    // iteration, before any bell or tick output exists, so a GPM app that accepts the socket
    // without replying would stop the whole batch with nothing on screen to say why.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`GPM API timed out after ${timeoutMs}ms`));
    });
  });
}

async function getProfiles() {
  const res = await callApi('/v2/profiles');
  const profiles = Array.isArray(res) ? res : res?.data;
  if (!Array.isArray(profiles)) throw new Error('List GPM profiles failed');
  return profiles;
}

function recordUncertainCreate(name, beforeIds, options = {}) {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) throw new Error('Uncertain GPM create marker needs a profile name');
  const id = crypto.randomUUID();
  const file = uncertainPath(id, options);
  writeJsonAtomic(file, {
    version: 1,
    id,
    name: normalizedName,
    beforeIds: beforeIds ? [...beforeIds] : null,
    reason: 'GPM create response was ambiguous',
    createdAt: new Date().toISOString(),
  });
  return { id, file };
}

function readUncertainCreate(id, options = {}) {
  const file = uncertainPath(id, options);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.version !== 1
    || record.id !== id
    || typeof record.name !== 'string'
    || !record.name.trim()
    || !(record.beforeIds === null
      || (Array.isArray(record.beforeIds) && record.beforeIds.every((value) => typeof value === 'string')))
    || typeof record.createdAt !== 'string') {
    throw new Error(`Invalid uncertain GPM create marker: ${id}`);
  }
  return record;
}

function listUncertainCreates(options = {}) {
  const directory = uncertainDirectory(options);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith('.json') && UUID_V4.test(file.slice(0, -5)))
    .map((file) => readUncertainCreate(file.slice(0, -5), options))
    .filter(Boolean)
    .map(({ id, name, beforeIds, createdAt }) => ({
      id,
      name,
      snapshotAvailable: Array.isArray(beforeIds),
      createdAt,
    }));
}

function assertNoUncertainCreates(options = {}) {
  const pending = listUncertainCreates(options);
  if (pending.length === 0) return;
  const error = new Error(
    `Unresolved uncertain GPM create marker(s): ${pending.map((entry) => entry.id).join(', ')}. `
    + 'Run "node gpm-api.js --list-uncertain" before starting more automation.',
  );
  error.code = GPM_CREATE_UNCERTAIN;
  throw error;
}

function removeUncertainCreate(id, options = {}) {
  const file = uncertainPath(id, options);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

async function reconcileUncertainCreate(id, options = {}) {
  const marker = readUncertainCreate(id, options);
  if (!marker) return null;
  const getProfilesFn = options.getProfilesFn || getProfiles;
  const stopProfileFn = options.stopProfileFn || stopProfile;
  const deleteProfileFn = options.deleteProfileFn || deleteProfile;
  const profiles = await getProfilesFn();
  const namedProfiles = profiles.filter((profile) => profile.name === marker.name && profileId(profile));
  const candidates = Array.isArray(marker.beforeIds)
    ? namedProfiles.filter((profile) => !marker.beforeIds.includes(profileId(profile)))
    : namedProfiles;

  if (!Array.isArray(marker.beforeIds) && candidates.length > 0) {
    throw new Error('Cannot reconcile automatically because the pre-create GPM snapshot is unavailable');
  }
  if (candidates.length > 1) {
    throw new Error(`Cannot reconcile automatically: found ${candidates.length} possible GPM profiles`);
  }
  if (candidates.length === 1) {
    const idToDelete = profileId(candidates[0]);
    await Promise.resolve().then(() => stopProfileFn(idToDelete)).catch(() => {});
    await deleteProfileFn(idToDelete);
  }
  removeUncertainCreate(id, options);
  return { id, outcome: candidates.length === 1 ? 'deleted' : 'not-found' };
}

function discardUncertainCreate(id, { confirm = false, ...options } = {}) {
  if (confirm !== true) throw new Error('Discarding an uncertain GPM marker requires confirm=true');
  return removeUncertainCreate(id, options);
}

function parseCliArgs(argv) {
  let action = null;
  let id = null;
  let confirm = false;

  for (const arg of argv) {
    let nextAction = null;
    let nextId = null;
    if (arg === '--list-uncertain') {
      nextAction = 'list';
    } else if (arg.startsWith('--reconcile=')) {
      nextAction = 'reconcile';
      nextId = validateRecoveryId(arg.slice('--reconcile='.length));
    } else if (arg.startsWith('--discard=')) {
      nextAction = 'discard';
      nextId = validateRecoveryId(arg.slice('--discard='.length));
    } else if (arg === '--confirm') {
      if (confirm) throw new Error('Duplicate option: --confirm');
      confirm = true;
      continue;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (action) throw new Error('Choose exactly one of --list-uncertain, --reconcile=<uuid>, or --discard=<uuid>');
    action = nextAction;
    id = nextId;
  }

  if (!action) {
    throw new Error('Choose one of --list-uncertain, --reconcile=<uuid>, or --discard=<uuid>');
  }
  if (confirm && action !== 'discard') throw new Error('--confirm is only valid with --discard=<uuid>');
  if (action === 'discard' && !confirm) throw new Error('--discard requires --confirm');
  return { action, id, confirm };
}

async function withMaintenanceGuard(options, callback) {
  const directory = path.resolve(options.runtimeDirectory || runtimeConfig.runtimeDirectory);
  const {
    createMaintenanceGuard,
    maintenanceLockPath,
    readAutomationLock,
  } = require('./automation-lock');
  fs.mkdirSync(directory, { recursive: true });
  const token = crypto.randomUUID();
  const guardFile = createMaintenanceGuard(directory, token);
  try {
    const lock = readAutomationLock(directory);
    if (lock.status === 'busy') {
      throw new Error(`Automation is still running under PID ${lock.owner?.pid || 'unknown'}.`);
    }
    if (lock.status === 'stale') {
      throw new Error('A stale automation lock exists. Run "node automation-lock.js --clear-stale" first.');
    }
    return await callback({ runtimeDirectory: directory });
  } finally {
    try {
      const current = JSON.parse(fs.readFileSync(guardFile, 'utf8'));
      if (current.token === token && guardFile === maintenanceLockPath(directory)) fs.unlinkSync(guardFile);
    } catch {}
  }
}

async function runCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseCliArgs(argv);
  const output = options.output || console.log;
  const runtimeDirectory = path.resolve(options.runtimeDirectory || runtimeConfig.runtimeDirectory);
  if (parsed.action === 'list') {
    const entries = listUncertainCreates({ runtimeDirectory });
    if (entries.length === 0) output('No uncertain GPM create markers.');
    else entries.forEach((entry) => output(JSON.stringify(entry)));
    return entries;
  }

  return withMaintenanceGuard({ runtimeDirectory }, async (maintenanceOptions) => {
    if (parsed.action === 'reconcile') {
      const result = await reconcileUncertainCreate(parsed.id, {
        ...maintenanceOptions,
        getProfilesFn: options.getProfilesFn,
        stopProfileFn: options.stopProfileFn,
        deleteProfileFn: options.deleteProfileFn,
      });
      if (!result) throw new Error(`Uncertain GPM create marker not found: ${parsed.id}`);
      output(`Reconciled ${result.id}: ${result.outcome}.`);
      return result;
    }

    const removed = discardUncertainCreate(parsed.id, { ...maintenanceOptions, confirm: parsed.confirm });
    if (!removed) throw new Error(`Uncertain GPM create marker not found: ${parsed.id}`);
    output(`Discarded local marker ${parsed.id} by explicit operator confirmation.`);
    return { id: parsed.id, outcome: 'discarded' };
  });
}

function profileId(profile) {
  return profile?.id || profile?.profile_id || profile?._id || null;
}

/**
 * Tạo profile tạm thời.
 * @param {string} name Tên profile (ví dụ email)
 * @param {string} proxyChuoi proxy định dạng IP:Port hoặc IP:Port:User:Pass
 * @returns {Promise<string>} Trả về profile_id
 */
async function createProfile(name, proxy = '') {
  assertNoUncertainCreates();
  // GPM API v2 support proxy parameter: IP:Port:User:Pass
  let proxyParam = '';
  if (proxy) {
    proxyParam = `&proxy=${encodeURIComponent(proxy)}`;
  }
  
  let beforeIds = null;
  try {
    beforeIds = new Set(
      (await getProfiles()).filter((profile) => profile.name === name).map(profileId).filter(Boolean),
    );
  } catch (error) {
    console.warn(`[GPM] Could not snapshot profiles before create: ${error.message}`);
  }
  // Persist intent before the remote mutation. If this process exits while /create is in
  // flight, the next run must reconcile instead of assuming no profile was created.
  const evidence = recordUncertainCreate(name, beforeIds);
  const endpoint = `/v2/create?name=${encodeURIComponent(name)}${proxyParam}&canvas=off&font=off&webrtc=on`;
  try {
    const res = await callApi(endpoint);
    if (res?.profile_id) {
      removeUncertainCreate(evidence.id);
      return res.profile_id;
    }
    throw new Error('Create Profile returned no profile id');
  } catch (error) {
    if (beforeIds) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidates = (await getProfiles().catch(() => []))
          .filter((profile) => profile.name === name && !beforeIds.has(profileId(profile)));
        if (candidates.length === 1 && profileId(candidates[0])) {
          const recoveredId = profileId(candidates[0]);
          removeUncertainCreate(evidence.id);
          console.warn(`[GPM] Create response failed, recovered profile id ${recoveredId} from profile list.`);
          return recoveredId;
        }
        if (candidates.length > 1) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    const uncertainError = new Error(
      `GPM create response was ambiguous; recovery marker ${evidence.id} remains. Stop automation and reconcile it explicitly.`,
    );
    uncertainError.code = GPM_CREATE_UNCERTAIN;
    uncertainError.recoveryId = evidence.id;
    uncertainError.preserveAutomationLock = true;
    throw uncertainError;
  }
}

/**
 * Mở profile và trả về cổng kết nối CDP
 * @param {string} profileId 
 * @returns {Promise<string>} Địa chỉ debug (VD: 127.0.0.1:62561)
 */
async function startProfile(profileId) {
  const endpoint = `/v2/start?profile_id=${encodeURIComponent(profileId)}`;
  const res = await callApi(endpoint);
  
  if (res && res.selenium_remote_debug_address) {
    return res.selenium_remote_debug_address;
  }
  throw new Error('Start Profile returned no debug address');
}

/**
 * Đóng trình duyệt của profile
 */
async function stopProfile(profileId) {
  const endpoint = `/v2/stop?profile_id=${encodeURIComponent(profileId)}`;
  const res = await callApi(endpoint);
  if (res?.status === false) throw new Error('Stop Profile failed');
  return res;
}

/**
 * Xóa vĩnh viễn profile (xóa cả data ổ cứng với mode=2)
 */
async function deleteProfile(profileId) {
  const endpoint = `/v2/delete?profile_id=${encodeURIComponent(profileId)}&mode=2`;
  const res = await callApi(endpoint);
  if (res?.status === false && !isMissingProfileResponse(res)) throw new Error('Delete Profile failed');
  return res;
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  GPM_CREATE_UNCERTAIN,
  assertNoUncertainCreates,
  createProfile,
  deleteProfile,
  discardUncertainCreate,
  getProfiles,
  listUncertainCreates,
  parseCliArgs,
  readUncertainCreate,
  reconcileUncertainCreate,
  recordUncertainCreate,
  removeUncertainCreate,
  runCli,
  startProfile,
  stopProfile,
  uncertainDirectory,
};
