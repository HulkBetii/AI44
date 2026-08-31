const RESETTABLE_STATUSES = new Set(['credentials-rejected', 'already-registered']);
const MANUAL_STATUSES = new Set(['inactive', 'need to recover password']);

const FULL_CYCLE_PHASES = [
  { phaseId: 'signup', workflowId: 'signup', modeArgs: [], dynamic: false },
  { phaseId: 'resume-1', workflowId: 'resume', modeArgs: ['--resume'], dynamic: true },
  { phaseId: 'reset-password', workflowId: 'resetPassword', modeArgs: ['--reset-password'], dynamic: true },
  { phaseId: 'resume-2', workflowId: 'resume', modeArgs: ['--resume'], dynamic: true },
];

function normalizeAccount(account) {
  return {
    status: String(account.status || '').trim().toLowerCase(),
    hasPassword: Boolean(account.elevenPass),
    hasKey: Boolean(account.apiKey),
  };
}

function getStateEligibleWorkflows(account) {
  const { status, hasPassword, hasKey } = normalizeAccount(account);
  const eligible = [];

  if (MANUAL_STATUSES.has(status)) return eligible;
  if (hasPassword) eligible.push('regenerateKey');
  if (hasKey) return eligible;

  if (status === 'pending' && !hasPassword) eligible.push('signup', 'retryPending');
  if (RESETTABLE_STATUSES.has(status)) eligible.push('resetPassword');
  if (status !== 'complete' && hasPassword && !RESETTABLE_STATUSES.has(status)) {
    eligible.push('resume');
  }
  if (status !== 'pending' && status !== 'complete'
    && !hasPassword && !RESETTABLE_STATUSES.has(status)) {
    eligible.push('retryPending');
  }

  if (eligible.some((workflow) => ['signup', 'resume', 'resetPassword'].includes(workflow))) {
    eligible.push('fullCycle');
  }
  return [...new Set(eligible)];
}

function getEligibleWorkflows(account) {
  return [...new Set([...getStateEligibleWorkflows(account), 'resetPassword'])];
}

function isEligibleForWorkflow(account, workflowId, { explicitReset = false } = {}) {
  if (workflowId === 'resetPassword' && explicitReset) return true;
  return getStateEligibleWorkflows(account).includes(workflowId);
}

function getRecommendedAction(account) {
  const eligible = getStateEligibleWorkflows(account);
  return ['signup', 'resume', 'retryPending', 'resetPassword', 'regenerateKey']
    .find((workflow) => eligible.includes(workflow)) || null;
}

module.exports = {
  FULL_CYCLE_PHASES,
  MANUAL_STATUSES,
  RESETTABLE_STATUSES,
  getEligibleWorkflows,
  getRecommendedAction,
  getStateEligibleWorkflows,
  isEligibleForWorkflow,
};
