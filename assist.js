// Assistant for conversations and emails. Uses the app's AI (ai.js) when ANTHROPIC_API_KEY is set; otherwise it reads the
// message text with simple rules. Either way it only suggests: it never sends, saves a customer record or promises anything.
const SYSTEM = `You help Bright Clean office staff with customer conversations. Use ONLY the messages given.
Never invent prices, dates, availability, commitments, insurance or customer statements. If something is unknown, say it will be confirmed.
Reply with JSON only, no prose: {"summary": string, "requests": [string], "unanswered_questions": [string], "suggested_reply": string, "next_action": string, "needs_human": boolean, "human_reason": string}.
The suggested reply is a draft for a person to review and send.`;

const clip = (s, n) => String(s || '').slice(0, n);
const list = (a, n) => (Array.isArray(a) ? a : []).map(x => clip(x, 300)).filter(Boolean).slice(0, n);

function fromRules(lines) {
  const inbound = lines.filter(l => l.dir === 'in');
  const last = lines[lines.length - 1];
  const unanswered = inbound.filter(l => /\?/.test(l.body || '') && !lines.some(o => o.dir === 'out' && o.at > l.at));
  const questions = unanswered.flatMap(l => String(l.body).split(/(?<=\?)/).filter(s => /\?/.test(s)).map(s => s.trim()));
  const rules = [[/start date|when can you start|availability|schedule|walkthrough/i, 'Scheduling or a walkthrough'], [/quote|price|pricing|estimate|bid/i, 'Pricing or a quote'], [/invoice|payment|balance|paid/i, 'Invoice or payment'], [/contract|sign|agreement/i, 'Contract or signature'], [/insurance|certificate|coi/i, 'Insurance certificate']];
  const text = lines.map(l => l.body || '').join(' ');
  const requests = rules.filter(([re]) => re.test(text)).map(([, label]) => label);
  const human = /complain|refund|damage|unhappy|angry|lawyer|cancel|injur/i.exec(text);
  return {
    summary: `${lines.length} message${lines.length === 1 ? '' : 's'}. ${last ? 'Last from ' + (last.dir === 'in' ? 'the customer' : 'us') + ': "' + clip(last.body, 160) + '"' : 'No messages yet.'}`,
    requests, unanswered_questions: questions.slice(0, 6),
    suggested_reply: '',
    next_action: unanswered_has(lines, inbound) ? 'Reply to the customer.' : 'No reply is waiting.',
    needs_human: !!human, human_reason: human ? 'The message mentions "' + human[0] + '". A person should read it.' : ''
  };
}
function unanswered_has(lines, inbound) { return inbound.some(l => !lines.some(o => o.dir === 'out' && o.at > l.at)); }

// lines: [{dir: 'in'|'out', at, channel, body}], kind: 'conversation' | 'email'
async function assist(app, lines, kind) {
  const aiOn = app.locals.aiOn && app.locals.aiOn();
  const rules = fromRules(lines);
  if (!aiOn || !app.locals.aiCall) return { source: 'rules', note: 'AI is off (ANTHROPIC_API_KEY is not set in Render). This is built from the message text only.', ...rules };
  const transcript = lines.slice(-30).map(l => `[${l.at}] ${l.dir === 'in' ? 'Customer' : 'Bright Clean'} (${l.channel || kind}): ${clip(l.body, 1500)}`).join('\n');
  try {
    const text = await app.locals.aiCall([{ role: 'user', content: 'Conversation (oldest first):\n' + transcript + '\n\nReturn the JSON now.' }], SYSTEM, 900);
    const m = String(text).replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('The AI reply was not in the expected format.');
    const j = JSON.parse(m[0]);
    return {
      source: 'ai', note: 'Written by AI from the messages. A person reviews it before anything is sent.',
      summary: clip(j.summary, 800), requests: list(j.requests, 8), unanswered_questions: list(j.unanswered_questions, 6),
      suggested_reply: clip(j.suggested_reply, 2000), next_action: clip(j.next_action, 300),
      needs_human: !!j.needs_human, human_reason: clip(j.human_reason, 300)
    };
  } catch (err) {
    return { source: 'rules', note: 'AI could not answer just now (' + err.message + '). This is built from the message text only.', ...rules };
  }
}

module.exports = { assist };
