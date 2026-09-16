/** Pure read-only planning for Account and Pane Strategy synchronization. */

function syncIssue(code, message) {
  return Object.freeze({ code, message, phase: 'strategy_sync_planning', retryable: false });
}

export function planStrategySync({ local_source_sha256, account, pane_instances } = {}) {
  const errors = [];
  let accountAction = 'blocked';
  if (local_source_sha256 && account) {
    if (account.exists === false) accountAction = 'create';
    else if (account.exists === true && account.source_sha256) {
      accountAction = account.source_sha256 === local_source_sha256 ? 'reuse' : 'update';
    }
  }

  let paneAction = 'blocked';
  const matches = pane_instances?.matches || [];
  const accountVersion = account?.script?.version ?? null;
  const paneVersion = matches[0]?.version ?? null;
  const paneVersionMatches = accountVersion != null && paneVersion != null
    ? String(accountVersion) === String(paneVersion)
    : null;
  if (account?.exists === true && accountVersion == null) {
    errors.push(syncIssue(
      'ACCOUNT_STRATEGY_VERSION_UNAVAILABLE',
      'Account Saved Strategy version is unavailable; sync action cannot be verified.',
    ));
  }
  if (matches.length === 1 && paneVersion == null) {
    errors.push(syncIssue(
      'PANE_STRATEGY_VERSION_UNAVAILABLE',
      'Pane Strategy version is unavailable; latest-version reuse or refresh cannot be verified.',
    ));
  }
  if (accountAction !== 'blocked') {
    if (matches.length === 0) paneAction = 'add_latest';
    else if (matches.length === 1) {
      if (accountVersion == null || paneVersion == null) paneAction = 'blocked';
      else paneAction = accountAction === 'reuse' && paneVersionMatches === true ? 'reuse' : 'refresh';
    } else {
      paneAction = 'ambiguous';
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    account_action: accountAction,
    pane_action: paneAction,
    local_source_sha256: local_source_sha256 || null,
    account_source_sha256: account?.source_sha256 || null,
    source_matches: account?.exists && local_source_sha256
      ? account.source_sha256 === local_source_sha256
      : null,
    account_version: accountVersion,
    pane_version: paneVersion,
    pane_version_matches: paneVersionMatches,
  });
}
