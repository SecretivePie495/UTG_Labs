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

// Steps carry a `key` so a bottleneck-specific step can replace the tier's
// generic version of the same idea instead of the reader seeing both.
const TIERS = {
  SOLO: {
    title: 'Stop the Bleeding',
    lead:
      'At your volume every missed message is a real percentage of the month, so the ' +
      'first job is making sure nothing lands somewhere nobody looks.',
    steps: [
      { key: 'one_inbox', head: 'One inbox.', body: 'Every channel you use lands in one place, so there is no app you forgot to check.' },
      { key: 'fast_reply', head: 'A first reply that goes out fast.', body: 'Someone answers while they are still reading, not that evening.' },
      { key: 'followup', head: 'A follow-up you do not have to remember.', body: 'Anyone who goes quiet gets checked back on.' }
    ]
  },
  GROWING: {
    title: 'Filter Before You Talk',
    lead:
      'You are getting enough volume that the problem has flipped: it is no longer ' +
      'missing messages, it is spending your day on the ones that were never going to book.',
    steps: [
      { key: 'qualify', head: 'Qualify before it reaches you.', body: 'The basics get asked and answered before it hits your desk.' },
      { key: 'flag_ready', head: 'Ready-to-talk gets flagged.', body: 'The people worth your time surface at the top.' },
      { key: 'answer_everyone', head: 'Everyone else still gets an answer.', body: 'Nobody is ignored, and nobody eats an hour.' }
    ]
  },
  SCALED: {
    title: 'See the Leak',
    lead:
      'At your volume the loss is not one dropped message, it is a pattern nobody has ' +
      'measured yet — and that pattern is worth real money every month.',
    steps: [
      { key: 'measure', head: 'Find where it drops.', body: 'Response times and dropped threads, measured instead of guessed.' },
      { key: 'coverage', head: 'Cover the gap that costs the most.', body: 'Usually nights, weekends, or the second message.' },
      { key: 'visible', head: 'Keep it visible.', body: 'You see what came in, what got answered, and what slipped.' }
    ]
  }
};

// Q6 ("Where does it actually break down?") is the single most specific thing a
// reader tells us, and the tier — which comes only from Q2 volume — ignores it.
// This is their answer turned into the first move, so the plan opens on the
// problem they named rather than a generic one.
//
// Indexed by the option's position in quiz.html QUESTIONS[5].options, not its
// text, so a copy experiment that rewrites Q6's wording cannot silently
// mis-route the advice. Same rationale as tierFor() on the page.
const BOTTLENECKS = [
  { key: 'one_inbox', head: 'One place for everything.', body: 'Every channel you use lands in a single inbox, so there is no app anyone forgot to check.' },
  { key: 'coverage', head: 'Cover the hours you are closed.', body: 'Nights and weekends get watched, so a Saturday message gets a real answer on Saturday.' },
  { key: 'fast_reply', head: 'A reply while they are still reading.', body: 'Someone answers in minutes instead of hours, which is usually the whole difference between booked and gone.' },
  { key: 'followup', head: 'Follow-up you never have to remember.', body: 'Anyone who goes quiet gets checked back on until they answer or say no.' }
];

// The bottleneck fix leads, then the tier fills the rest — skipping any tier
// step that repeats what the bottleneck step already said. Always three steps.
function planSteps(tier, bottleneckIndex) {
  const tierSteps = TIERS[tier].steps;
  const fix = BOTTLENECKS[bottleneckIndex];
  if (!fix) return tierSteps;
  return [fix].concat(tierSteps.filter((s) => s.key !== fix.key)).slice(0, 3);
}

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

const DEFAULT_HOOK = 'https://n8n.srv1167236.hstgr.cloud/webhook/quiz-lead';
const DEFAULT_REPLY_TO = 'udo@utglabs.com';

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

// One sentence in the reader's own numbers. Returns raw text and is escaped at
// the point it enters the HTML, so the plain-text body stays readable. Empty
// when they skipped Q7, so it never invents a figure they didn't give.
function stakesLine(answers) {
  return answers.value_anchor
    ? `You put the cost of letting that keep happening at ${answers.value_anchor} a month.`
    : '';
}

function buildEmail(firstName, tier, answers, bottleneckIndex) {
  const plan = TIERS[tier];
  const name = escapeHtml(firstName);
  const chosen = planSteps(tier, bottleneckIndex);
  const stakes = stakesLine(answers);

  const steps = chosen
    .map(({ head, body }) => `<li style="margin:0 0 14px"><strong>${head}</strong> ${body}</li>`)
    .join('');

  const recap = ANSWER_FIELDS.filter(([key]) => answers[key])
    .map(([key, label]) => `<tr><td style="padding:2px 12px 2px 0;color:#777">${label}</td>` +
      `<td style="padding:2px 0">${escapeHtml(answers[key])}</td></tr>`)
    .join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#1a1a1a;max-width:560px">
<p>${name},</p>
<p>Here is your plan: <strong>${plan.title}</strong>.</p>
<p>${plan.lead}${stakes ? ' ' + escapeHtml(stakes) : ''}</p>
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
    stakes ? plan.lead + ' ' + stakes : plan.lead,
    '',
    ...chosen.map(({ head, body }, i) => `${i + 1}. ${head} ${body}`),
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

  // Read per request rather than at module load, so a changed env var takes
  // effect without waiting for a cold start.
  const hook = process.env.N8N_QUIZ_WEBHOOK || DEFAULT_HOOK;
  const hookSecret = process.env.N8N_QUIZ_SECRET;

  if (!hookSecret) {
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

  // Which Q6 option they picked, by position. Anything that isn't one of the
  // four known options falls back to the tier's generic steps rather than
  // guessing, so a missing or junk value degrades instead of breaking.
  const bottleneckIndex = Number.isInteger(body.bottleneck_index) ? body.bottleneck_index : -1;

  const { subject, html, text } = buildEmail(firstName, tier, answers, bottleneckIndex);

  // The message is fully built here, so n8n is a dumb transport: it sends what
  // it is given and never composes prospect-facing copy from raw input.
  const payload = {
    to: email,
    reply_to: process.env.QUIZ_REPLY_TO || DEFAULT_REPLY_TO,
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
  const res = await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-quiz-secret': hookSecret },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(9000)
  }).catch((err) => {
    console.error('n8n unreachable', err.message);
    return null;
  });

  if (!res) return { statusCode: 502, body: JSON.stringify({ error: 'send failed' }) };

  // n8n answers 200 even when the workflow throws before reaching its Respond
  // node, so the status alone cannot be trusted. Only the Respond OK node emits
  // {"ok":true}; an empty body means the send died upstream of it. The page uses
  // our status to decide whether to promise an inbox delivery, so a false 200
  // here becomes a lie on screen.
  const reply = await res.text();
  let confirmed = false;
  try {
    confirmed = JSON.parse(reply).ok === true;
  } catch (err) {
    confirmed = false;
  }

  if (!res.ok || !confirmed) {
    console.error('n8n did not confirm the send', res.status, reply.slice(0, 200));
    return { statusCode: 502, body: JSON.stringify({ error: 'send failed' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

// Exported for the self-check below and nothing else.
exports._internals = { buildEmail, validEmail, cleanText, planSteps, TIERS, BOTTLENECKS };

// One runnable check: `node netlify/functions/quiz-lead.js`
if (require.main === module) {
  const assert = require('assert');
  const { buildEmail, validEmail, cleanText, planSteps } = exports._internals;
  const ALL_TIERS = ['SOLO', 'GROWING', 'SCALED'];

  assert.ok(validEmail('sam@example.com'));
  assert.ok(!validEmail('not-an-email'));
  assert.ok(!validEmail('a@b.c'));
  assert.ok(!validEmail('a'.repeat(250) + '@example.com'));

  assert.strictEqual(cleanText(' hi\nthere ', 40), 'hi there');
  assert.strictEqual(cleanText('x'.repeat(200), 10), 'x'.repeat(10));
  assert.strictEqual(cleanText(undefined, 10), '');

  const built = buildEmail('Sam', 'SOLO', { business_type: 'Cleaning', deals_per_month: '0–5' }, -1);
  assert.ok(built.subject.includes('Stop the Bleeding'));
  assert.ok(built.html.includes('One inbox.'));
  assert.ok(built.text.includes('1. One inbox.'));
  assert.ok(built.html.includes('Cleaning'), 'recap includes answered fields');
  assert.ok(!built.html.includes('Avg deal size'), 'unanswered fields are omitted');

  // The bottleneck they named leads the plan, in both bodies.
  for (const tier of ALL_TIERS) {
    BOTTLENECKS.forEach((fix, i) => {
      const m = buildEmail('Sam', tier, {}, i);
      assert.ok(m.html.indexOf(fix.head) !== -1, `${tier}/${i} html opens on the bottleneck`);
      assert.ok(m.text.includes('1. ' + fix.head), `${tier}/${i} text opens on the bottleneck`);

      const steps = planSteps(tier, i);
      assert.strictEqual(steps.length, 3, `${tier}/${i} still has three steps`);
      const keys = steps.map((s) => s.key);
      assert.strictEqual(new Set(keys).size, 3, `${tier}/${i} says nothing twice: ${keys}`);
      assert.strictEqual(keys[0], fix.key, `${tier}/${i} bottleneck fix goes first`);
    });
  }

  // Different bottlenecks at the same tier must not produce the same email —
  // that was the whole point of the change.
  const solo0 = buildEmail('Sam', 'SOLO', {}, 0).text;
  const solo1 = buildEmail('Sam', 'SOLO', {}, 1).text;
  assert.notStrictEqual(solo0, solo1, 'bottleneck changes the plan');
  assert.ok(solo1.includes('Cover the hours you are closed.'));
  assert.ok(!solo1.includes('A follow-up you do not have to remember.'), 'third tier step gives way');

  // An out-of-range or missing index degrades to the tier plan, never throws.
  for (const bad of [-1, 99, undefined, null, 'nights', 1.5]) {
    const m = buildEmail('Sam', 'GROWING', {}, bad);
    assert.ok(m.html.includes('Qualify before it reaches you.'), `index ${bad} falls back`);
  }

  // Their own number, only when they gave one.
  const withStakes = buildEmail('Sam', 'SOLO', { value_anchor: '$1,500–$3,000' }, 2);
  assert.ok(withStakes.text.includes('$1,500–$3,000 a month'), 'stakes line uses their figure');
  assert.ok(withStakes.html.includes('$1,500'), 'stakes line reaches the html');
  assert.ok(!buildEmail('Sam', 'SOLO', {}, 2).text.includes('You put the cost'),
    'no stakes line invented when Q7 is unanswered');

  // Injection: a name is attacker-controlled and must not become live markup.
  const evil = buildEmail('<img src=x onerror=alert(1)>', 'SOLO', {}, 0);
  assert.ok(!evil.html.includes('<img'), 'name is escaped into the html');
  assert.ok(evil.html.includes('&lt;img'));

  // A value anchor is attacker-controlled too, and it now reaches the body copy.
  const evilStakes = buildEmail('Sam', 'SOLO', { value_anchor: '<script>x</script>' }, 0);
  assert.ok(!evilStakes.html.includes('<script>'), 'stakes line is escaped');

  // Copy constraint: nothing customer-facing may mention AI or automation.
  // Checked across every tier x bottleneck pair, since both now supply copy.
  for (const tier of ALL_TIERS) {
    for (const i of [-1, 0, 1, 2, 3]) {
      const m = buildEmail('Sam', tier, { value_anchor: '$500–$1,500' }, i);
      assert.ok(!/\bAI\b|automat|chatbot|\bbot\b/i.test(m.text), `${tier}/${i} copy stays human`);
    }
  }

  console.log('quiz-lead: all checks passed');
}
