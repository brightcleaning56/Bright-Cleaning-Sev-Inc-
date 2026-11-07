// All runtime configuration comes from environment variables.
// Nothing secret is ever hard-coded or committed.
const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || '',
  dataFile: env.DATA_FILE || './data/buildintel.json',
  backupDir: env.BACKUP_DIR || './data/backups',
  // Plan-room files. On Render the persistent disk is mounted at /var/data.
  docDir: env.DOC_DIR || (process.env.NODE_ENV === 'production' ? '/var/data/docs' : './data/docs'),
  maxDocBytes: Number(env.MAX_DOC_MB || 40) * 1024 * 1024,
  backupKey: env.BACKUP_KEY || '',            // 64 hex chars (32 bytes) for AES-256-GCM
  appSecret: env.APP_SECRET || '',            // signs unsubscribe links + sessions
  ownerEmail: env.OWNER_EMAIL || '',          // platform owner bootstrap
  ownerPassword: env.OWNER_PASSWORD || '',

  // Email: 'dry-run' records messages but never sends. 'live' sends through Postmark.
  emailMode: env.EMAIL_MODE === 'live' ? 'live' : 'dry-run',
  postmarkToken: env.POSTMARK_TOKEN || '',
  platformFrom: env.PLATFORM_FROM || '',
  postmarkStream: env.POSTMARK_STREAM || 'outbound',
  inboundReplyAddress: env.INBOUND_REPLY_ADDRESS || '', // e.g. abc123@inbound.postmarkapp.com
  postmarkWebhookSecret: env.POSTMARK_WEBHOOK_SECRET || '',
  emailDomainVerified: env.EMAIL_DOMAIN_VERIFIED === 'true', // set only after SPF/DKIM/DMARC pass

  stripeSecret: env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  stripePrices: {
    starter: env.STRIPE_PRICE_STARTER || '',
    professional: env.STRIPE_PRICE_PROFESSIONAL || '',
    business: env.STRIPE_PRICE_BUSINESS || '',
    local: env.STRIPE_PRICE_LOCAL || '',
    regional: env.STRIPE_PRICE_REGIONAL || '',
    national: env.STRIPE_PRICE_NATIONAL || '',
  },

  samApiKey: env.SAM_API_KEY || '',
  // Brute-force protection: sign-in attempts allowed per IP per 15 minutes (default 10; raised only for automated QA).
  // Off-site backup copies (any S3-compatible storage). All five must be set to enable.
  offsite: env.BACKUP_S3_ENDPOINT && env.BACKUP_S3_BUCKET && env.BACKUP_S3_KEY_ID && env.BACKUP_S3_SECRET
    ? { endpoint: env.BACKUP_S3_ENDPOINT, bucket: env.BACKUP_S3_BUCKET, region: env.BACKUP_S3_REGION || 'auto', accessKeyId: env.BACKUP_S3_KEY_ID, secretAccessKey: env.BACKUP_S3_SECRET } : null,
  // Phase 2 switch: 'on' groups search, map, command center and profiles by permanent project (Project Intelligence Core);
  // 'off' keeps the original address grouping. Run scripts/core-parity.mjs against a copy of the live database first.
  // WS1 stage A: project search in PostgreSQL (identical results; see test/sql-reads.test.js). Needs DATABASE_URL.
  sqlReads: (env.SQL_READS || 'off').toLowerCase() === 'on' ? 'on' : 'off',
  coreReads: (env.CORE_READS || 'off').toLowerCase() === 'on' ? 'on' : 'off',
  loginRateLimit: Number(env.LOGIN_RATE_LIMIT || 10),
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  aiDailyLimit: Number(env.AI_DAILY_LIMIT || 25),
  socrataAppToken: env.SOCRATA_APP_TOKEN || '',

  cycleMinutes: Number(env.CYCLE_MINUTES || 60),
  schedulerEnabled: env.SCHEDULER !== 'off',

  // Owner attestations for things software cannot verify. Each must be a date string
  // plus evidence reference, set by the owner — never by a developer.
  attest: {
    attorneyReview: env.ATTEST_ATTORNEY_REVIEW || '',
    insuranceBound: env.ATTEST_INSURANCE_BOUND || '',
    penTest: env.ATTEST_PENTEST || '',
    securityContact: env.SECURITY_CONTACT || '',
  },
};

export function isProduction() {
  return env.NODE_ENV === 'production';
}
