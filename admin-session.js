// Admin sign-in cookie. The session token lives in an HttpOnly cookie, so page scripts cannot read it
// and a script injected into the page cannot copy it away for later use.
// SameSite=Lax: other sites cannot send it on a POST, fetch or iframe request.
// Cookie-authenticated requests that change data must also send the X-BC-CSRF header, which a plain
// cross-site form cannot set; the admin page sends it on every call.
// A Bearer token in the Authorization header still works, for scripts and tests.
const NAME = 'bc_admin';
const MAX_AGE = 8 * 3600;

function readCookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}

const isSecure = req => !!req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');

// The admin token for this request: the Bearer header if present, otherwise the sign-in cookie.
function tokenFrom(req) {
  const h = String(req.headers.authorization || '').replace(/^Bearer /, '');
  return h || readCookie(req, NAME);
}

// True when the request is signed in by the cookie rather than a Bearer header.
function fromCookie(req) {
  return !String(req.headers.authorization || '').startsWith('Bearer ') && !!readCookie(req, NAME);
}

function setCookie(req, res, token) {
  res.append('Set-Cookie', `${NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${isSecure(req) ? '; Secure' : ''}`);
}

function clearCookie(req, res) {
  res.append('Set-Cookie', `${NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`);
}

module.exports = { tokenFrom, fromCookie, setCookie, clearCookie };
