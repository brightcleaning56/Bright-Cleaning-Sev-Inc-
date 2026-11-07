// Kept separate from pgstore.js so it can be used (and tested) without the PostgreSQL driver installed.
/** TLS for Postgres. Connections that cross the internet verify the server certificate by default (optionally against
 *  PGSSL_CA). Turning verification off needs PGSSL_NO_VERIFY=true and is reported as a failing launch gate.
 *  Private-network URLs (e.g. Render's internal hostname) don't use TLS. */
export function pgTls(url, explicit, env = process.env) {
  if (explicit !== undefined) return { ssl: explicit, mode: explicit ? (explicit.rejectUnauthorized === false ? 'no-verify' : 'verify') : 'off' };
  const wantsTls = /sslmode=(require|verify-ca|verify-full)|render\.com|neon\.tech|supabase|amazonaws\.com|azure\.com/.test(url);
  if (!wantsTls) return { ssl: undefined, mode: 'private-network' };
  if (env.PGSSL_NO_VERIFY === 'true') return { ssl: { rejectUnauthorized: false }, mode: 'no-verify' };
  return { ssl: { rejectUnauthorized: true, ...(env.PGSSL_CA ? { ca: env.PGSSL_CA.replace(/\\n/g, '\n') } : {}) }, mode: 'verify' };
}
