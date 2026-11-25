// A readable device line from a browser's user-agent text, e.g. 'Chrome on Windows'. Used for proposal view history.
function describeAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown device';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /bot|crawl|spider|preview/i.test(s) ? 'Bot or link preview' : 'Browser';
  const os = /iPhone|iPad/.test(s) ? 'iPhone/iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'unknown system';
  return browser + ' on ' + os;
}
module.exports = { describeAgent };
