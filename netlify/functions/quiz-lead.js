// Emails a quiz taker their tiered plan. The quiz page POSTs the answers here
// on submit; this function validates them and builds the message, then hands it
// to an n8n workflow that does the actual sending.
//
// Why the split: n8n owns the mail credential (and can grow a Chatwoot step
// later), but the webhook must not be callable from a browser — so it stays
// server-side behind this function, authenticated with a shared secret, rather
// than being fetched from the page.
//
// This function owns the email copy on purpose. The page never sends a body —
// if it did, anyone could POST arbitrary HTML and this endpoint would happily
// send it from the utglabs.com domain. The tier copy is therefore duplicated
// between here and quiz.html's TIERS; keep the two in sync when copy changes.
//
// ponytail: no rate limit. The endpoint is public, so someone could pump
// templated mail at an address they typed. Content is fixed and honest so the
// blast radius is small. Add Netlify rate limiting or a Turnstile token if it
// ever gets abused.

const TIERS = {
  SOLO: {
    title: 'Stop the Bleeding',
    lead:
      'At your volume every missed message is a real percentage of the month, so the ' +
      'first job is making sure nothing lands somewhere nobody looks.',
    steps: [
      ['One inbox.', 'Every channel you use lands in one place, so there is no app you forgot to check.'],
      ['A first reply that goes out fast.', 'Someone answers while they are still reading, not that evening.'],
      ['A follow-up you do not have to remember.', 'Anyone who goes quiet gets checked back on.']
    ]
  },
  GROWING: {
    title: 'Filter Before You Talk',
    lead:
      'You are getting enough volume that the problem has flipped: it is no longer ' +
      'missing messages, it is spending your day on the ones that were never going to book.',
    steps: [
      ['Qualify before it reaches you.', 'The basics get asked and answered before it hits your desk.'],
      ['Ready-to-talk gets flagged.', 'The people worth your time surface at the top.'],
      ['Everyone else still gets an answer.', 'Nobody is ignored, and nobody eats an hour.']
    ]
  },
  SCALED: {
    title: 'See the Leak',
    lead:
      'At your volume the loss is not one dropped message, it is a pattern nobody has ' +
      'measured yet — and that pattern is worth real money every month.',
    steps: [
      ['Find where it drops.', 'Response times and dropped threads, measured instead of guessed.'],
      ['Cover the gap that costs the most.', 'Usually nights, weekends, or the second message.'],
      ['Keep it visible.', 'You see what came in, what got answered, and what slipped.']
    ]
  }
};

// Labels match the quiz questions, in order, so the recap reads back to them.
const ANSWER_FIELDS = [
  ['business_type', 'Business'],
  ['deals_per_month', 'Deals per month'],
  ['avg_deal_size', 'Avg deal size'],
  ['reply_speed', 'Reply speed'],
  ['inbound_handling', 'Who handles inbound'],
  ['bottleneck', 'Biggest bottleneck'],
  ['value_anchor', 'What a reply is worth']
];

const HOOK = process.env.N8N_QUIZ_WEBHOOK || 'https://n8n.srv1167236.hstgr.cloud/webhook/quiz-lead';
const HOOK_SECRET = process.env.N8N_QUIZ_SECRET;
const REPLY_TO = process.env.QUIZ_REPLY_TO || 'udo@utglabs.com';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validEmail(v) {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

// Everything past this point is attacker-controlled, so each field is length
// capped and HTML escaped at the point it enters the message.
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function buildEmail(firstName, tier, answers) {
  const plan = TIERS[tier];
  const name = escapeHtml(firstName);

  const steps = plan.steps
    .map(([head, body]) => `<li style="margin:0 0 14px"><strong>${head}</strong> ${body}</li>`)
    .join('');

  const recap = ANSWER_FIELDS.filter(([key]) => answers[key])
    .map(([key, label]) => `<tr><td style="padding:2px 12px 2px 0;color:#777">${label}</td>` +
      `<td style="padding:2px 0">${escapeHtml(answers[key])}</td></tr>`)
    .join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#1a1a1a;max-width:560px">
<p>${name},</p>
<p>Here is your plan: <strong>${plan.title}</strong>.</p>
<p>${plan.lead}</p>
<ol style="padding-left:20px">${steps}</ol>
<p>Want me to show you with your real inbox? 15 minutes, no pitch — just a live look at what it'd catch.</p>
<p>Just reply to this email and I'll set it up.</p>
<p>— Udo<br>UTG Labs</p>
<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 16px">
<p style="font-size:13px;color:#777;margin:0 0 8px">What you told me:</p>
<table style="font-size:13px;border-collapse:collapse">${recap}</table>
</div>`;

  const text = [
    `${firstName},`,
    '',
    `Here is your plan: ${plan.title}.`,
    '',
    plan.lead,
    '',
    ...plan.steps.map(([head, body], i) => `${i + 1}. ${head} ${body}`),
    '',
    "Want me to show you with your real inbox? 15 minutes, no pitch — just a live look at what it'd catch.",
    '',
    "Just reply to this email and I'll set it up.",
    '',
    '— Udo',
    'UTG Labs',
    '',
    'What you told me:',
    ...ANSWER_FIELDS.filter(([key]) => answers[key]).map(([key, label]) => `${label}: ${answers[key]}`)
  ].join('\n');

  return { subject: `${firstName}, here's your plan: ${plan.title}`, html, text };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  if (!HOOK_SECRET) {
    // Misconfigured rather than malformed. The page handles this — the lead is
    // already in PostHog, so a missing secret costs the email, not the lead.
    return { statusCode: 503, body: JSON.stringify({ error: 'sender not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bad json' }) };
  }

  const email = cleanText(body.email, 254);
  const firstName = cleanText(body.first_name, 60);
  const tier = cleanText(body.tier, 10).toUpperCase();

  if (!validEmail(email)) return { statusCode: 400, body: JSON.stringify({ error: 'bad email' }) };
  if (!firstName) return { statusCode: 400, body: JSON.stringify({ error: 'missing first_name' }) };
  if (!TIERS[tier]) return { statusCode: 400, body: JSON.stringify({ error: 'bad tier' }) };

  // Only the seven known fields are read. Anything else the caller sends is
  // dropped rather than echoed into the message.
  const answers = {};
  for (const [key2] of ANSWER_FIELDS) answers[key2] = cleanText(body[key2], 120);

  const { subject, html, text } = buildEmail(firstName, tier, answers);

  // The message is fully built here, so n8n is a dumb transport: it sends what
  // it is given and never composes prospect-facing copy from raw input.
  const payload = {
    to: email,
    reply_to: REPLY_TO,
    subject: subject,
    html: html,
    text: text,
    first_name: firstName,
    tier: tier,
    answers: answers
  };
  if (process.env.LEAD_NOTIFY_EMAIL) payload.bcc = process.env.LEAD_NOTIFY_EMAIL;

  // n8n on a small VPS can be slow to wake; give up rather than hold the
  // browser's request open, since the page has already rendered the plan.
  const res = await fetch(HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-quiz-secret': HOOK_SECRET },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(9000)
  }).catch((err) => {
    console.error('n8n unreachable', err.message);
    return null;
  });

  if (!res || !res.ok) {
    if (res) console.error('n8n rejected', res.status, await res.text());
    return { statusCode: 502, body: JSON.stringify({ error: 'send failed' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

// Exported for the self-check below and nothing else.
exports._internals = { buildEmail, validEmail, cleanText, TIERS };

// One runnable check: `node netlify/functions/quiz-lead.js`
if (require.main === module) {
  const assert = require('assert');
  const { buildEmail, validEmail, cleanText } = exports._internals;

  assert.ok(validEmail('sam@example.com'));
  assert.ok(!validEmail('not-an-email'));
  assert.ok(!validEmail('a@b.c'));
  assert.ok(!validEmail('a'.repeat(250) + '@example.com'));

  assert.strictEqual(cleanText(' hi\nthere ', 40), 'hi there');
  assert.strictEqual(cleanText('x'.repeat(200), 10), 'x'.repeat(10));
  assert.strictEqual(cleanText(undefined, 10), '');

  const built = buildEmail('Sam', 'SOLO', { business_type: 'Cleaning', deals_per_month: '0–5' });
  assert.ok(built.subject.includes('Stop the Bleeding'));
  assert.ok(built.html.includes('One inbox.'));
  assert.ok(built.text.includes('1. One inbox.'));
  assert.ok(built.html.includes('Cleaning'), 'recap includes answered fields');
  assert.ok(!built.html.includes('Avg deal size'), 'unanswered fields are omitted');

  // Injection: a name is attacker-controlled and must not become live markup.
  const evil = buildEmail('<img src=x onerror=alert(1)>', 'SOLO', {});
  assert.ok(!evil.html.includes('<img'), 'name is escaped into the html');
  assert.ok(evil.html.includes('&lt;img'));

  // Copy constraint: nothing customer-facing may mention AI or automation.
  for (const tier of ['SOLO', 'GROWING', 'SCALED']) {
    const m = buildEmail('Sam', tier, {});
    assert.ok(!/\bAI\b|automat|chatbot|\bbot\b/i.test(m.text), tier + ' copy stays human');
  }

  console.log('quiz-lead: all checks passed');
}
