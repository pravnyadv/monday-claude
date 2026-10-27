const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expandMentions, minifyHtml, styleIssues, composePost, mentionIds } = require('../lib/post');
const { resolvePerson } = require('../mon.js');

const people = { _note: 'x', 'Alex Morgan': '70000001', 'Jordan Lee': '70000002', 'CASEY KIM': '70000003', 'Sam Roe': '1', Samuel: '2' };
const opts = { people, resolve: resolvePerson };

test('expandMentions: @First and @{Full Name} become anchors with the monday spelling', () => {
  const { html, mentioned } = expandMentions('<p>Hi @Alex, and @{casey kim}.</p>', people, resolvePerson);
  assert.match(html, /data-mention-id="70000001">@Alex Morgan<\/a>,/);
  assert.match(html, /data-mention-id="70000003">@CASEY KIM<\/a>\./);
  assert.deepEqual(mentioned.map((m) => m.id), ['70000001', '70000003']);
});

test('expandMentions: emails, escaped \\@, tag attributes and existing anchors are left alone', () => {
  const src = '<p>mail a@b.com, literal \\@here</p><a href="x" data-mention-id="70000002">@Jordan Lee</a>';
  const { html, mentioned } = expandMentions(src, people, resolvePerson);
  assert.equal(html, '<p>mail a@b.com, literal @here</p><a href="x" data-mention-id="70000002">@Jordan Lee</a>');
  assert.deepEqual(mentioned, []);
});

test('expandMentions: unknown or ambiguous names throw instead of posting plain text', () => {
  assert.throws(() => expandMentions('<p>@Nobody</p>', people, resolvePerson), /Unknown person "Nobody"/);
  assert.throws(() => expandMentions('<p>@Sa</p>', people, resolvePerson), /Ambiguous person "Sa"/);
});

test('minifyHtml: no whitespace between tags, newlines inside text become spaces', () => {
  assert.equal(minifyHtml('<p>a\n b</p>\n<ul>\n  <li>x</li>\n</ul>\n'), '<p>a b</p><ul><li>x</li></ul>');
  assert.equal(minifyHtml('<p>CC: <a>@A</a> <a>@B</a></p>'), '<p>CC: <a>@A</a> <a>@B</a></p>'); // the space between mentions is kept
});

test('styleIssues: dashes, arrows, dots and curly quotes in visible text, including entities', () => {
  assert.deepEqual(styleIssues('<p>plain - hyphen, 10-11 July, a-b</p>'), []);
  const kinds = (h) => styleIssues(h).map((i) => i.split(':')[0]);
  assert.deepEqual(kinds('<p>a \u2014 b</p>'), ['em or en dash']);
  assert.deepEqual(kinds('<p>x &rarr; y</p>'), ['arrow']);
  assert.deepEqual(kinds('<p>x -&gt; y</p>'), ['arrow']);
  assert.deepEqual(kinds('<p>a \u00B7 b</p>'), ['middle dot or bullet character']);
  assert.deepEqual(kinds('<p>\u201Cq\u201D</p>'), ['curly quote', 'curly quote']);
  assert.deepEqual(kinds('<a href="http://x/a->b">link</a>'), []); // attributes aren't text
});

test('composePost: CC goes on its own last line, minified; style issues block unless allowed', () => {
  const { html, mentions } = composePost('<p>Hi @Alex</p>\n<p>done</p>', { ...opts, cc: ['Jordan', 'Casey'] });
  assert.match(html, /<\/p><p>done<\/p><p>CC: <a [^>]*70000002[^>]*>@Jordan Lee<\/a> <a [^>]*70000003[^>]*>@CASEY KIM<\/a><\/p>$/);
  assert.deepEqual(mentions.map((m) => m.name), ['Alex Morgan', 'Jordan Lee', 'CASEY KIM']);
  assert.throws(() => composePost('<p>a \u2014 b</p>', opts), /writing rules/);
  assert.equal(composePost('<p>a \u2014 b</p>', { ...opts, allowStyle: true }).html, '<p>a \u2014 b</p>');
});

test('composePost: a cc that is already mentioned in the body is refused', () => {
  assert.throws(() => composePost('<p>@Alex hi</p>', { ...opts, cc: ['Alex Morgan'] }), /already mentioned/);
});

test('mentionIds reads every anchor id', () => {
  assert.deepEqual(mentionIds('<a data-mention-id="1">x</a> <a data-mention-id="22">y</a>'), ['1', '22']);
});
