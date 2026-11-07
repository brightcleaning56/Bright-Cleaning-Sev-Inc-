import { config } from './config.js';
import { canCollect } from './sources/registry.js';
import { activeRateCards } from './estimate.js';

const DAY = 864e5;
const gate = (id, name, status, evidence, owner) => ({ id, name, status, evidence, owner });

/** status: pass | fail | owner_action. Nothing passes without evidence. */
export function readiness(store) {
  const g = [];
  const orgs = store.list('orgs', o => o.status === 'active' && o.kind !== 'buyer');
  const meta = store.list('jobs', j => j.type === 'backup' || j.type === 'restore_test').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lastBackup = meta.filter(j => j.type === 'backup' && j.status === 'ok').pop();
  const lastRestore = meta.filter(j => j.type === 'restore_test').pop();

  g.push(gate('secrets', 'App secret configured', config.appSecret.length >= 32 ? 'pass' : 'fail',
    config.appSecret.length >= 32 ? 'APP_SECRET set (length ok)' : 'APP_SECRET missing or < 32 chars', 'Deployer'));

  g.push(gate('owner', 'Platform owner account', store.list('users', u => u.role === 'platform_owner').length ? 'pass' : 'owner_action',
    'platform_owner users: ' + store.list('users', u => u.role === 'platform_owner').length, 'Eric'));

  const goodOrgs = orgs.filter(o => o.legal?.name && o.legal?.postalAddress && o.senderEmail);
  g.push(gate('tenant', 'Active tenant with legal identity', goodOrgs.length ? 'pass' : 'owner_action',
    `${orgs.length} active, ${goodOrgs.length} with legal name + postal address + sender`, 'Eric (Bright Clean details)'));

  const priced = goodOrgs.filter(o => activeRateCards(store, o.id).length);
  g.push(gate('rates', 'Owner-approved rate cards', priced.length && priced.length === goodOrgs.length ? 'pass' : 'owner_action',
    goodOrgs.map(o => `${o.slug}: ${activeRateCards(store, o.id).length} approved`).join('; ') || 'no tenants', 'Eric (approve pricing)'));

  const srcs = store.list('sources');
  const authorized = srcs.filter(s => s.enabled && canCollect(s));
  const fresh = authorized.filter(s => s.lastRecordDate && Date.now() - Date.parse(s.lastRecordDate) < 30 * DAY);
  const stale = authorized.filter(s => !fresh.includes(s));
  const unreviewed = srcs.filter(s => !canCollect(s));
  g.push(gate('sources', 'Authorized data sources (≥1, fresh within 30 days)', fresh.length ? 'pass' : authorized.length ? 'fail' : 'owner_action',
    [`Live: ${fresh.map(s => s.key).join(', ') || 'none'}`,
     stale.length && `Authorized but stale or failing: ${stale.map(s => `${s.key}${s.lastError ? ' (' + s.lastError + ')' : ''}`).join(', ')}`,
     unreviewed.length && `Terms not yet reviewed: ${unreviewed.map(s => s.key).join(', ')}`].filter(Boolean).join('. '),
    'Eric + attorney (terms review)'));

  const samples = store.list('permits', p => p.sample);
  g.push(gate('no_samples', 'No sample data in production', samples.length ? 'fail' : 'pass', `${samples.length} sample permits`, 'Developer'));

  const emailOk = config.emailMode === 'live' && config.postmarkToken && config.emailDomainVerified;
  g.push(gate('email', 'Email provider live + domain authenticated', emailOk ? 'pass' : 'owner_action',
    `mode=${config.emailMode}; token=${config.postmarkToken ? 'set' : 'missing'}; SPF/DKIM/DMARC attested=${config.emailDomainVerified}`, 'Eric (Postmark + DNS)'));

  const leadPrices = ['local', 'regional', 'national'].filter(k => config.stripePrices[k]);
  const payOk = config.stripeSecret && config.stripeWebhookSecret && leadPrices.length === 3;
  g.push(gate('payments', 'Payments connected', payOk ? 'pass' : 'owner_action',
    `secret=${!!config.stripeSecret}; webhook=${!!config.stripeWebhookSecret}; lead plan prices=${leadPrices.length}/3`, 'Eric (Stripe)'));

  const backupOk = config.backupKey && lastBackup && Date.now() - Date.parse(lastBackup.createdAt) < 26 * 3600e3;
  g.push(gate('backup', 'Encrypted backup in last 26h', backupOk ? 'pass' : config.backupKey ? 'fail' : 'owner_action',
    lastBackup ? `last ${lastBackup.createdAt} (${lastBackup.result?.bytes} bytes)` : 'no backup yet', 'Deployer'));
  const restoreOk = lastRestore?.status === 'ok' && Date.now() - Date.parse(lastRestore.createdAt) < 8 * DAY;
  g.push(gate('restore', 'Restore test passed in last 8 days', restoreOk ? 'pass' : 'fail',
    lastRestore ? `${lastRestore.status} at ${lastRestore.createdAt}; checksum ${lastRestore.result?.restoredChecksum?.slice(0, 12) || lastRestore.result?.error}` : 'never run', 'Deployer'));

  const docs = store.list('documents', d => !d.removed).length;
  const vault = lastRestore?.result?.vault;
  g.push(gate('documents_backup', 'Plan-room drawings backed up and restorable', !docs ? 'pass' : vault?.ok && restoreOk ? 'pass' : 'fail',
    !docs ? 'no plan-room files yet' : vault ? `${vault.documents} file(s); ${vault.verifiedPdfs} decrypted and fingerprint-checked; missing ${vault.missingBlobs.length}, failed ${vault.failed.length}` : 'documents never backed up', 'Deployer'));
  const off = store.list('jobs', j => j.type === 'offsite').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();
  const offOk = off?.status === 'ok' && Date.now() - Date.parse(off.createdAt) < 26 * 3600e3;
  g.push(gate('offsite', 'Off-site backup copy in last 26h', offOk ? 'pass' : config.offsite ? 'fail' : 'owner_action',
    off ? `${off.status} at ${off.createdAt}${off.result?.error ? ': ' + off.result.error : ` (${off.result?.uploaded} new object(s))`}` : 'not configured: set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_REGION, BACKUP_S3_KEY_ID, BACKUP_S3_SECRET', 'Owner'));

  const pgOk = store.kind === 'postgres' && !store.lastFlushError;
  { const staff = store.list('users', u => !u.disabled && (u.role === 'platform_owner' || (u.platformRoles || []).length));
    const without = staff.filter(u => !u.mfa?.sealed);
    g.push(gate('staff_mfa', 'Platform staff use MFA (authenticator app)', without.length ? 'owner_action' : 'pass',
      without.length ? `${without.length} staff account(s) without MFA: ${without.slice(0, 5).map(u => u.email).join(', ')} — set it up in /admin → My security` : `${staff.length} staff account(s), all with MFA`, 'Owner')); }
  if (store.kind === 'postgres' && store.conflicts) { const recent = store.conflicts.filter(c => Date.now() - Date.parse(c.at) < 24 * 3600e3);
    g.push(gate('write_conflicts', 'No unresolved write conflicts in the last 24h', recent.length ? 'fail' : 'pass',
      recent.length ? `${recent.length} conflict(s), e.g. ${recent.slice(0, 3).map(c => c.collection + '/' + c.id).join(', ')} — database copy kept; see audit log "write.conflict"` : 'versioned writes active; change notifications ' + (store.listenerError ? 'ERROR: ' + store.listenerError : 'connected'), 'Deployer')); }
  if (store.kind === 'postgres' && store.tls) g.push(gate('db_tls', 'Database connection encrypted and verified', store.tls.mode === 'no-verify' ? 'fail' : 'pass',
    { verify: 'TLS with certificate verification', 'private-network': 'private network connection (no internet hop)', 'no-verify': 'TLS WITHOUT certificate verification (PGSSL_NO_VERIFY=true): set PGSSL_CA instead', off: 'TLS off' }[store.tls.mode], 'Deployer'));
  g.push(gate('database', 'Production database (PostgreSQL) writing cleanly', pgOk ? 'pass' : store.lastFlushError ? 'fail' : 'owner_action',
    store.kind === 'postgres' ? (store.lastFlushError ? `last write failed ${store.lastFlushError.at}: ${store.lastFlushError.message}` : `postgres; last write ${store.lastFlushAt || 'pending'}`) : 'JSON file storage (fine for the Bright Clean pilot; set DATABASE_URL before outside subscribers)',
    'Deployer'));

  const a = config.attest;
  g.push(gate('attorney', 'Attorney review of policies + data reuse', a.attorneyReview ? 'pass' : 'owner_action', a.attorneyReview || 'not attested', 'Attorney'));
  g.push(gate('insurance', 'Cyber + tech E&O insurance bound', a.insuranceBound ? 'pass' : 'owner_action', a.insuranceBound || 'not attested', 'Insurance broker'));
  g.push(gate('pentest', 'Independent penetration test', a.penTest ? 'pass' : 'owner_action', a.penTest || 'not attested', 'Security vendor'));
  g.push(gate('security_contact', 'Named security/privacy contact', a.securityContact ? 'pass' : 'owner_action', a.securityContact || 'none', 'Eric'));

  const passed = g.filter(x => x.status === 'pass').length;
  // Pilot (dry-run) can run once the operational gates pass; live sending needs everything.
  const pilotGates = ['secrets', 'owner', 'tenant', 'rates', 'sources', 'no_samples', 'backup', 'restore'];
  const pilotReady = pilotGates.every(id => g.find(x => x.id === id).status === 'pass');
  return { verdict: passed === g.length ? 'GO' : 'NO-GO', pilotReady, passed, total: g.length, gates: g, at: new Date().toISOString() };
}
