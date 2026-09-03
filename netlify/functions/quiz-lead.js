// Emails a quiz taker their tiered plan. The quiz page POSTs the answers here
// on submit; this function validates them, builds the message, renders the
// personalized one-page plan as a PDF, and sends it straight to Resend.
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

// Layout for the attached plan PDF. It receives the plan copy already built in
// this file, so pdf generation only owns how it looks.
const { buildDoc, renderPdf } = require('./lib/plan-pdf')._internals;
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

// The iPhone text-replacement shortcuts, keyed by tier — the same ones the
// original plan templates carried in their "Set It Up on Your iPhone" section.
// Each is a [type, phrase] pair rendered as a table on the attached PDF, so the
// lead gets the copy-paste snippets without having to type prompts out.
const SHORTCUTS = {
  SOLO: [
    [';ack', 'Hey [name]! Got your message — I personally read and reply to everything. You’ll hear back by end of day. If it’s urgent, reply URGENT.'],
    [';book', 'Would love to sort you out. Got 15 minutes later today or tomorrow? Just send a time that works and I’ll be there.'],
    [';after', 'Just saw this — I’m wrapping up for the night. You’re top of my list first thing tomorrow. — Udo'],
    [';price', 'Happy to talk numbers. Each project is scoped to what you actually need, so give me 5 minutes to understand it and I’ll send you a straight number — no surprises.'],
    [';done', 'Sorted. Everything you need is in your messages/email. Questions anytime. — Udo']
  ],
  GROWING: [
    [';qual', 'Quick questions so I can help you faster: 1) What’s your timeline to get started? 2) What’s your budget range for this? 3) Have you worked with a [coach/agency] before?'],
    [';book', 'Those answers help a lot. Looks like a fit — here’s my calendar, grab 15 minutes and we’ll map it out.'],
    [';nurture', 'No rush at all. When you’ve got more clarity on timing, reply here and we’ll pick it back up. In the meantime, start with this: [tip]. — Udo'],
    [';escalate', 'Real lead. [name] answered all 3 with specifics — book them and route to me.'],
    [';filter', 'Appreciate it! Just to save you time — we’re best for someone ready to start within [90 days]. If that’s you, tell me more and I’ll get you sorted.']
  ],
  SCALED: [
    [';log', '[name] reached out about [topic] at [time]. High intent (asked about pricing). I replied at [time]. Flag if slower than [2h].'],
    [';hi', 'Thanks [name] — this looks like one to move on. Putting you with [person], our fastest. You’ll hear from us shortly. — Udo'],
    [';gen', 'Good to hear from you. General inquiry over here — routing you to [person], you’ll get a full answer shortly.'],
    [';cover', 'Escalate: [name] has been quiet since [time] on [topic]. Nights/weekends gap — cover now.']
  ]
};

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

const DEFAULT_FROM = 'Udo at UTG Labs <udo@utglabs.com>';
const DEFAULT_REPLY_TO = 'udo.donyekwere@gmail.com';

// A lead is worth knowing about the moment it lands, so the blind copy is on by
// default rather than waiting on an env var — an unset variable used to mean the
// lead arrived and nobody was told. Goes to the address the owner actually
// reads, which has to be monitored anyway for the funnel to work at all.
// Override with LEAD_NOTIFY_EMAIL, or set it to "off" to stop the copies.
const DEFAULT_NOTIFY = 'udo.donyekwere@gmail.com';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Empty string means "send no copy". Anything else is the address to blind
// copy, defaulting to DEFAULT_NOTIFY so the copy happens without configuration.
function notifyAddress(configured) {
  const v = (configured || '').trim();
  if (!v) return DEFAULT_NOTIFY;
  return v.toLowerCase() === 'off' ? '' : v;
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
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.QUIZ_FROM_EMAIL || DEFAULT_FROM;

  if (!apiKey) {
    // Misconfigured rather than malformed. The page handles this — the lead is
    // already in PostHog, so a missing key costs the email, not the lead.
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
  const plan = TIERS[tier];
  const steps = planSteps(tier, bottleneckIndex);
  const stakes = stakesLine(answers);

  const payload = {
    from: from,
    to: [email],
    reply_to: [process.env.QUIZ_REPLY_TO || DEFAULT_REPLY_TO],
    subject: subject,
    html: html,
    text: text
  };
  const notify = notifyAddress(process.env.LEAD_NOTIFY_EMAIL);
  if (notify) payload.bcc = [notify];

  // Personalized one-page plan, rendered and attached. If rendering fails the
  // email still goes out — the fine print and the promise don't depend on it.
  try {
    const pdf = await renderPdf(buildDoc({
      title: plan.title,
      lead: plan.lead,
      steps: steps,
      stakes: stakes,
      firstName: firstName,
      shortcuts: SHORTCUTS[tier]
    }));
    payload.attachments = [{
      filename: `${tier.toLowerCase()}-plan.pdf`,
      content: pdf.toString('base64')
    }];
  } catch (err) {
    console.error('plan pdf render failed', err.message);
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(9000)
  }).catch((err) => {
    console.error('resend unreachable', err.message);
    return null;
  });

  if (!res) return { statusCode: 502, body: JSON.stringify({ error: 'send failed' }) };

  if (!res.ok) {
    const detail = await res.text();
    console.error('resend rejected', res.status, detail);
    return { statusCode: 502, body: JSON.stringify({ error: 'send failed' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

// Exported for the self-check below and nothing else.
exports._internals = { buildEmail, validEmail, cleanText, planSteps, notifyAddress, TIERS, BOTTLENECKS };

// One runnable check: `node netlify/functions/quiz-lead.js`
if (require.main === module) {
  const assert = require('assert');
  const { buildEmail, validEmail, cleanText, planSteps, notifyAddress } = exports._internals;
  const ALL_TIERS = ['SOLO', 'GROWING', 'SCALED'];

  assert.ok(validEmail('sam@example.com'));
  assert.ok(!validEmail('not-an-email'));
  assert.ok(!validEmail('a@b.c'));
  assert.ok(!validEmail('a'.repeat(250) + '@example.com'));

  // A missing env var must still notify — that silence is how a lead gets missed.
  assert.strictEqual(notifyAddress(undefined), 'udo.donyekwere@gmail.com');
  assert.strictEqual(notifyAddress(''), 'udo.donyekwere@gmail.com');
  assert.strictEqual(notifyAddress('  '), 'udo.donyekwere@gmail.com');
  assert.strictEqual(notifyAddress('sam@example.com'), 'sam@example.com');
  assert.strictEqual(notifyAddress(' sam@example.com '), 'sam@example.com');
  assert.strictEqual(notifyAddress('off'), '', 'opt out is possible');
  assert.strictEqual(notifyAddress('OFF'), '');

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

  // The attached PDF is built from the same plan copy as the email, so it must
  // render for every tier and carry their personalized figure. Render is async,
  // so this check is deferred to the end.
  const { buildDoc, renderPdf } = require('./lib/plan-pdf')._internals;

  Promise.all(ALL_TIERS.map(async (tier) => {
    const steps = planSteps(tier, 0);
    const pdf = await renderPdf(buildDoc({
      title: TIERS[tier].title,
      lead: TIERS[tier].lead,
      steps: steps,
      stakes: stakesLine({ value_anchor: '$1,500–$3,000' }),
      firstName: 'Sam',
      shortcuts: SHORTCUTS[tier]
    }));
    assert.ok(Buffer.isBuffer(pdf) && pdf.slice(0, 4).toString() === '%PDF', `${tier} renders a PDF`);
  })).then(() => {
    console.log('quiz-lead: all checks passed');
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
