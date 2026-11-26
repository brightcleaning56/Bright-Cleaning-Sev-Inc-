// Checks the reply wording rules for leads that come from our own lead feeds (API keys):
// they must be treated as outreach, not as a request the person sent us.
// Run: node tests/lead-source-reply-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'ai.js'), 'utf8');

// 1. The API-key branch no longer tells the AI the person sent a request through a partner.
const apiLine = src.split('\n').find(l => l.includes("origin === 'api'")) || '';
assert.ok(apiLine, 'the API-key lead branch exists');
assert.ok(!/partner|received your request|Thank them for their interest/i.test(apiLine), 'API-key leads are not described as partner requests');
assert.ok(/REACH_OUT/.test(apiLine), 'API-key leads use the outreach instructions');
console.log('ok - feed leads are treated as outreach');

// 2. The outreach instructions forbid thanks for interest and naming the source.
const reach = src.split('\n').find(l => l.includes('const REACH_OUT')) || '';
assert.ok(/Never thank them for their interest/.test(reach), 'outreach text forbids thanking them for interest');
assert.ok(/never say how or from where we got their contact/.test(reach), 'outreach text forbids naming the source');
console.log('ok - outreach wording forbids thanks for interest and naming the source');

// 3. A reply that fails to parse is retried once, and the parser reads the outermost JSON braces.
assert.ok(/try \{ ai = parseJSON\(await ask\(\)\); \}/.test(src), 'triage retries once when the reply does not parse');
assert.ok(/lastIndexOf\('\}'\)/.test(src), 'parser reads up to the last closing brace');
console.log('ok - triage retries an unparseable reply once');

console.log('lead source reply: all checks passed');
