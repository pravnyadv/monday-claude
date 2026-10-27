/**
 * Turning a drafted update into the exact HTML monday should receive: @Name mentions become real
 * mention anchors, a CC line is added, whitespace between tags is removed (monday renders every
 * newline as a blank line), and the text is checked against the writing rules before it is sent.
 */

const anchor = (id, name) =>
  `<a class="user_mention_editor router" data-mention-type="User" data-mention-id="${id}">@${name}</a>`;

/** `@{Full Name}` or `@First` in text (not inside a tag, an existing anchor, an email address or a URL path like /@user). */
const MENTION = /(^|[^\w.@\\/:])@(?:\{([^}]+)\}|([A-Za-z][\w-]*))/g;
const ANCHOR_ID = /data-mention-id="(\d+)"/g;

/** The display name for a person id: the people-map key, which is how monday spells it. */
function nameOf(people, id) {
  return Object.keys(people).find((n) => n[0] !== '_' && people[n] === String(id)) || String(id);
}

/** Run `fn` over the text between tags, leaving tags and the inside of <a>...</a> untouched. */
function mapText(html, fn) {
  let depthA = 0;

  return html.split(/(<[^>]+>)/).map((part) => {
    if (part.startsWith('<')) {
      if (/^<a[\s>]/i.test(part)) depthA++;
      if (/^<\/a>/i.test(part)) depthA = Math.max(0, depthA - 1);

      return part;
    }

    return depthA ? part : fn(part);
  }).join('');
}

/** Replace @mentions with anchors via `resolve(name) -> id`; `\@` stays a literal @. */
function expandMentions(html, people, resolve) {
  const mentioned = [];
  const out = mapText(html, (text) => text.replace(MENTION, (m, pre, braced, word) => {
    const id = resolve(people, braced || word);
    const name = nameOf(people, id);
    mentioned.push({ id: String(id), name });

    return pre + anchor(id, name);
  }).replace(/\\@/g, '@'));

  return { html: out, mentioned };
}

/** Every user id already mentioned by an anchor in the HTML. */
function mentionIds(html) {
  return [...String(html).matchAll(ANCHOR_ID)].map((m) => m[1]);
}

/** Drop the line breaks monday would render as blank lines. Whitespace between tags is dropped only when
 *  it spans a newline (formatting); a plain space between two inline tags (`</a> <a>`) is content. */
function minifyHtml(html) {
  return String(html).replace(/>[ \t]*\r?\n\s*</g, '><').replace(/\s*\n\s*/g, ' ').trim();
}

/** The writing rules: no em/en dashes, arrow glyphs, bullet or middle dots in prose, or curly quotes. */
const STYLE_RULES = [
  [/[\u2014\u2013]/, 'em or en dash'],
  [/[\u2190-\u21FF]|(?:^|\s)(?:->|=>|<-)(?:\s|$)/, 'arrow'],
  [/[\u00B7\u2022]/, 'middle dot or bullet character'],
  [/[\u2018\u2019\u201C\u201D]/, 'curly quote'],
];

function decodeEntities(text) {
  return text.replace(/&(mdash|ndash|rarr|larr|middot|bull|lsquo|rsquo|ldquo|rdquo|gt|lt|amp);/g, (m, e) => ({
    mdash: '\u2014', ndash: '\u2013', rarr: '\u2192', larr: '\u2190', middot: '\u00B7', bull: '\u2022',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D', gt: '>', lt: '<', amp: '&',
  })[e]);
}

/** Style problems in the visible text, each with a short excerpt to fix. */
function styleIssues(html) {
  const text = decodeEntities(String(html).replace(/<[^>]+>/g, ' '));
  const issues = [];
  for (const [re, what] of STYLE_RULES) {
    const g = new RegExp(re.source, 'g');
    for (const m of text.matchAll(g)) {
      issues.push(`${what}: "...${text.slice(Math.max(0, m.index - 25), m.index + 25).trim()}..."`);
    }
  }

  return issues;
}

/**
 * Build the final update HTML. `cc` names go on their own last line; a cc'd person who is already
 * mentioned in the body is an error (the greeting names the primary, CC lists everyone else once).
 * Throws on any style issue unless `allowStyle`.
 */
function composePost(body, { people, resolve, cc = [], allowStyle = false }) {
  const { html: expanded, mentioned } = expandMentions(String(body), people, resolve);
  const ccIds = cc.map((n) => String(resolve(people, n)));
  const inBody = new Set(mentionIds(expanded));
  const dupes = ccIds.filter((id) => inBody.has(id)).map((id) => nameOf(people, id));
  if (dupes.length) {
    throw new Error(`${dupes.join(', ')} already mentioned in the body; don't repeat them in --cc.`);
  }
  const ccHtml = ccIds.length ? `<p>CC: ${ccIds.map((id) => anchor(id, nameOf(people, id))).join(' ')}</p>` : '';
  const html = minifyHtml(expanded + ccHtml);
  const issues = styleIssues(html);
  if (issues.length && !allowStyle) {
    throw new Error(`Not posted, the text breaks the writing rules (pass --allow-style to post anyway):\n  ${issues.join('\n  ')}`);
  }

  return {
    html,
    mentions: [...mentioned, ...ccIds.map((id) => ({ id, name: nameOf(people, id) }))],
  };
}

module.exports = { anchor, expandMentions, mentionIds, minifyHtml, styleIssues, composePost, nameOf };
