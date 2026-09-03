// Renders the personalized one-page plan PDF attached to the lead email. Built
// with pdfmake (pure JS, no Chromium — fits a Netlify function). The content is
// passed in rather than assembled here, so this file owns layout and branding
// and quiz-lead.js stays the single source of truth for the plan copy — the
// PDF, the email, and the on-screen plan all read from the same title, lead,
// and steps, and this file only decides how they look on the page.
//
// Branding: dark card header, the UTG purple used across the quiz (#6c63ff),
// and a calm one-page layout that reads well attached to a short email.

const pdfmake = require('pdfmake/build/pdfmake.js');

// The font is embedded at render time via pdfmake's vfs (Roboto). Loading it
// once at module load keeps cold starts predictable.
pdfmake.vfs = require('pdfmake/build/vfs_fonts.js');
pdfmake.fonts = {
  Roboto: {
    normal: 'Roboto-Regular.ttf',
    bold: 'Roboto-Medium.ttf',
    italics: 'Roboto-Italic.ttf',
    bolditalics: 'Roboto-MediumItalic.ttf'
  }
};

const PURPLE = '#6c63ff';
const DARK = '#17181C';
const GRAY = '#555555';
const LIGHT = '#F4EEFF';

// The three step boxes, rendered top-to-bottom. `head` is the bold line, `body`
// the supporting sentence — the same pair the email and the on-screen plan show.
function stepStack(steps) {
  return [].concat(
    ...steps.map((step, i) => [
      {
        columns: [
          {
            width: 26,
            text: String(i + 1),
            alignment: 'center',
            margin: [0, 13, 0, 13],
            color: '#ffffff',
            background: PURPLE,
            style: 'stepNumber'
          },
          {
            margin: [10, 0, 0, 0],
            stack: [
              { text: step.head, bold: true, color: DARK, fontSize: 13 },
              { text: step.body, color: GRAY, fontSize: 11, margin: [0, 2, 0, 0] }
            ]
          }
        ],
        margin: [0, 0, 0, 10]
      }
    ])
  );
}

// Build the full doc-definition. All copy is trusted/honest content produced by
// quiz-lead.js (already HTML-escaped for email; here it's plain text in a PDF).
function buildDoc({ title, lead, steps, stakes, firstName }) {
  const nameLine = firstName
    ? `${firstName}, here’s your plan:`
    : 'Here’s your plan:';

  return {
    content: [
      // Header
      {
        background: '#FFFFFF',
        margin: [0, 0, 0, 14],
        stack: [
          {
            text: 'UTG LABS',
            fontSize: 10,
            characterSpacing: 2,
            color: PURPLE,
            bold: true,
            letterSpacing: 2
          },
          {
            text: title,
            fontSize: 26,
            bold: true,
            color: DARK,
            margin: [0, 4, 0, 0]
          }
        ]
      },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 3, lineColor: '#E5484D' }] },

      { text: nameLine, fontSize: 16, bold: true, color: DARK, margin: [0, 16, 0, 4] },
      { text: lead, color: GRAY, fontSize: 12, margin: [0, 0, 0, 12] },

      // Stakes callout, only when they gave a figure.
      ...(stakes
        ? [{
            background: '#FFF5F5',
            margin: [0, 0, 0, 18],
            style: 'stakesBox',
            stack: [
              {
                text: stakes,
                fontSize: 12.5,
                color: '#B4231F',
                margin: [14, 12, 14, 12]
              }
            ]
          }]
        : []),

      { text: 'Your 3 Moves', fontSize: 13, bold: true, color: PURPLE, characterSpacing: 1, margin: [0, 0, 0, 10] },
      ...stepStack(steps),

      // Footer
      {
        margin: [0, 22, 0, 0],
        stack: [
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: '#EEEEEE' }] },
          {
            text: 'Want me to show you with your real inbox? 15 minutes, no pitch. Just reply to this email.',
            fontSize: 10.5,
            color: GRAY,
            alignment: 'center',
            margin: [0, 14, 0, 4]
          },
          { text: '— Udo · UTG Labs', fontSize: 11, color: DARK, alignment: 'center' }
        ]
      }
    ],
    styles: {
      stepNumber: {
        fontSize: 12,
        bold: true,
        lineHeight: 1
      },
      stakesBox: {
        borderRadius: 4
      }
    },
    defaultStyle: {
      font: 'Roboto',
      fontSize: 12,
      lineHeight: 1.4
    },
    pageMargins: [48, 44, 48, 44],
    pageSize: 'LETTER'
  };
}

// Render the doc-definition to a PDF Buffer. Synchronous-ish via getBuffer().
function renderPdf(docDefinition) {
  return new Promise((resolve, reject) => {
    pdfmake.createPdf(docDefinition).getBuffer().then(
      (buf) => resolve(Buffer.from(buf)),
      reject
    );
  });
}

exports._internals = { buildDoc, renderPdf, stepStack };

if (require.main === module) {
  const assert = require('assert');

  const doc = buildDoc({
    title: 'Stop the Bleeding',
    lead: 'At your volume every missed message is a real percentage of the month.',
    steps: [
      { head: 'One inbox.', body: 'Every channel lands in one place.' },
      { head: 'A first reply that goes out fast.', body: 'Someone answers while they are still reading.' },
      { head: 'A follow-up you do not have to remember.', body: 'Anyone who goes quiet gets checked back on.' }
    ],
    stakes: 'You put the cost at $1,250 a month.',
    firstName: 'Sam'
  });

  assert.ok(JSON.stringify(doc).includes('Stop the Bleeding'), 'tier title present');
  assert.ok(JSON.stringify(doc).includes('Sam, here’s your plan:'), 'personalized name line');
  assert.ok(JSON.stringify(doc).includes('$1,250'), 'their figure is in the doc');

  // No stakes line means no callout rendered at all.
  const bare = buildDoc({
    title: 'See the Leak',
    lead: 'The loss is a pattern.', 
    steps: [{ head: 'H.', body: 'b.' }],
    stakes: '',
    firstName: ''
  });
  assert.ok(!JSON.stringify(bare).includes('You put the cost'), 'no stakes callout when none given');

  // And it renders to a real PDF.
  renderPdf(doc).then((buf) => {
    assert.ok(Buffer.isBuffer(buf) && buf.length > 1000, 'renders a non-trivial PDF');
    assert.strictEqual(buf.slice(0, 4).toString(), '%PDF', 'starts with the PDF header');
    console.log('plan-pdf: all checks passed');
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
