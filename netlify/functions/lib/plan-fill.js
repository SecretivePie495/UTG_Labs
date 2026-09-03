// Fills the tier's plan HTML template (plans/plan-<tier>.html) with the quiz
// taker's actual figures, so n8n can render it to a PDF and attach it to the
// lead email. The page's fine print promises "a copy", and the PDF is that
// copy, so the numbers printed on it must read from the same answers the quiz
// captured and the screen showed — never guessed, never generic.
//
// The HTML templates use $[placeholder] tokens for every figure. Each token is
// either a direct quiz answer or a small derived number. The mapping lives here
// and only here, so the copy team can read the templates as plain templates and
// anyone touching this file owns the math.
//
// No template means no PDF: if a tier's .html is missing we fall back to the
// existing plain-text + HTML email and it still goes out. The screen already
// rendered the plan and the lead is in PostHog; losing the attachment must not
// lose the lead.

const fs = require('fs');
const path = require('path');

// Template root. The .html plans ship beside the deployed site root (plans/),
// and this function's bundle lives under netlify/functions/. Resolve relative
// to the repo root so a local `node netlify/functions/quiz-lead.js` and the
// deployed function both find it. The root is the parent of netlify/.
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'plans');

// A representative number per Q3 ("Avg deal size") option. The template asks
// for a single "$/deal", so a range becomes the middle of the bucket rather
// than a raw "$2,000–$10,000" that would read badly inside "at $X/deal".
const DEAL_SIZE = {
  'under $500': 250,
  '$500–$2,000': 1250,
  '$2,000–$10,000': 6000,
  'more than $10,000': 15000
};

// Representative monthly deal volume per Q2 ("Deals per month") option, used
// where the template needs a plain count ("$[deals_per_month] deals/mo").
const DEALS_PER_MONTH = {
  '0–5': 5,
  '6–15': 12,
  '16–40': 25,
  'more than 40': 50
};

// Minutes of tire-kicker handling each deal costs, before real leads get a
// minute. Used only by the GROWING template's "[hh]/week" figure.
const MINUTES_PER_DEAL = 30;

// What fraction of volume a SCALED business leaks by not measuring reply
// speed, used for the "$[rough_calc]" monthly figure.
const SCALED_LEAK_RATE = 0.10;

// Normalise a quiz answer to a lookup key: lowercase, trim. The option text
// keeps its original casing in the recap, but the map keys are lowercase so a
// copy experiment that tweaks the wording still resolves to the same number.
function key(choice) {
  return String(choice || '').toLowerCase().trim();
}

// Turn a Q3 answer into a "deals-per-month"-style number. Falls back to the
// floor of the {\$500} solo bucket when the answer is junk, so a template never
// renders an empty "$/deal".
function dealSize(choice) {
  return DEAL_SIZE[key(choice)] || 250;
}

function dealsPerMonth(choice) {
  return DEALS_PER_MONTH[key(choice)] || 5;
}

// Hours per week the GROWING lead spends fielding tire-kickers. Deals in a
// month times minutes each, brought to weekly hours.
function hoursPerWeek(choice) {
  const monthly = dealsPerMonth(choice);
  return Math.round((monthly * MINUTES_PER_DEAL) / 60);
}

// Monthly value a SCALED lead leaks by not measuring reply speed: volume times
// a representative deal, times the leak rate.
function roughMonthlyLeak(dealsChoice, dealChoice) {
  return Math.round(dealsPerMonth(dealsChoice) * dealSize(dealChoice) * SCALED_LEAK_RATE);
}

// Format a dollar amount without trailing decimals, thousand-separated.
function dollars(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// The numbers are derived from the survey, not raw copy, so they never need
// HTML escaping — but the raw answers that fill the recap-style tokens could
// have come from anywhere, so any value that reaches the template is escaped.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build the map of token -> value for a tier. Each tier's template uses a
// different subset, so the map is scoped to the tier to avoid silently filling
// tokens that don't belong.
function fillMap(tier, answers) {
  const deals = answers.deals_per_month;
  const deal = answers.avg_deal_size;

  switch (tier) {
    case 'SOLO':
      return {
        'avg_deal_size': dollars(dealSize(deal)),
        'avg_deal_size x 12': dollars(dealSize(deal) * 12)
      };
    case 'GROWING':
      return {
        'deals_per_month': dealsPerMonth(deals),
        'hh': hoursPerWeek(deals)
      };
    case 'SCALED':
      return {
        'deals_per_month': dealsPerMonth(deals),
        'rough_calc': dollars(roughMonthlyLeak(deals, deal))
      };
    default:
      return null;
  }
}

// Read the tier's template and substitute every $[token]. Any token left
// (template/copy drift) is dropped with the bracket rather than left as a
// literal that would print on the PDF. Returns null when the template file is
// missing, which the caller treats as "send the email without a PDF".
function renderPlanHtml(tier, answers) {
  const map = fillMap(tier, answers);
  if (!map) return null;

  const file = path.join(TEMPLATE_DIR, `plan-${tier.toLowerCase()}.html`);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }

  // A leading `$` before the bracket is the currency symbol (e.g. "$[avg_deal_size]"),
  // not part of the token — so a token that had one keeps a `$` in front of its
  // value, and one that didn't (hours in "[hh]/week") stays bare. An unknown or
  // unfilled token renders as empty rather than a literal "[...]" on the PDF.
  return source.replace(/(\$?)\[([^\]]+)\]/g, (_, dollar, token) => {
    const value = Object.prototype.hasOwnProperty.call(map, token) ? map[token] : '';
    if (!value) return '';
    return (dollar ? '$' : '') + escapeHtml(value);
  });
}

exports._internals = {
  dealSize,
  dealsPerMonth,
  hoursPerWeek,
  roughMonthlyLeak,
  dollars,
  renderPlanHtml,
  fillMap
};

if (require.main === module) {
  const assert = require('assert');

  assert.strictEqual(dealSize('$500–$2,000'), 1250);
  assert.strictEqual(dealSize('under $500'), 250);
  assert.strictEqual(dealSize('whatever'), 250, 'junk falls back to solo floor');

  assert.strictEqual(dealsPerMonth('6–15'), 12);
  assert.strictEqual(dealsPerMonth('more than 40'), 50);

  assert.strictEqual(hoursPerWeek('6–15'), 6);
  assert.strictEqual(hoursPerWeek('0–5'), 3);

  assert.strictEqual(roughMonthlyLeak('16–40', '$2,000–$10,000'), 15000);

  assert.strictEqual(dollars(12500), '12,500');

  const solo = renderPlanHtml('SOLO', { avg_deal_size: '$500–$2,000' });
  assert.ok(solo, 'SOLO template exists and renders');
  assert.ok(solo.includes('$1,250'), 'avg deal size filled');
  assert.ok(solo.includes('$15,000'), 'avg_deal_size x 12 computed');
  assert.ok(!solo.includes('$['), 'no dangling placeholders');

  const growing = renderPlanHtml('GROWING', { deals_per_month: '16–40' });
  assert.ok(growing.includes('25 deals/mo'), 'deals per month filled');
  assert.ok(growing.includes('13') || growing.includes('13/'), 'hours per week filled');
  assert.ok(!growing.includes('$['), 'no dangling placeholders');

  const scaled = renderPlanHtml('SCALED', {
    deals_per_month: '16–40',
    avg_deal_size: '$2,000–$10,000'
  });
  assert.ok(scaled.includes('$25+ deals/mo'), 'scaled deals filled');
  assert.ok(scaled.includes('$15,000'), 'rough calc filled');
  assert.ok(!scaled.includes('$['), 'no dangling placeholders');

  // A missing tier template returns null, not a crash.
  assert.strictEqual(renderPlanHtml('NOPE', {}), null);

  console.log('plan-fill: all checks passed');
}
