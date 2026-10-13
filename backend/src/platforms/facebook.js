const HOME = 'https://www.facebook.com';

function searchText(prompt, content) {
  let raw = '';
  if (typeof content === 'object' && content?.title) {
    raw = `${content.title} ${content.text || ''}`;
  } else if (typeof content === 'string' && content !== prompt) {
    raw = `${prompt || ''} ${content}`;
  } else {
    raw = prompt || '';
  }

  // If user explicitly specifies a line like "Search in Facebook\nkeyword 1", prioritize the first focused line
  const searchMatch = raw.match(/search(?:\s+in\s+(?:facebook|fb))?[\s:]*\n+([^\n]+)/i);
  if (searchMatch && searchMatch[1]?.trim()) {
    const candidateLine = searchMatch[1].replace(/https?:\/\/\S+/gi, '').replace(/[^\w\s-#]/g, ' ').replace(/\s+/g, ' ').trim();
    if (candidateLine.length >= 3 && candidateLine.split(' ').length <= 5) {
      return candidateLine;
    }
  }

  // Remove URLs and domain names
  raw = raw.replace(/https?:\/\/\S+/gi, ' ').replace(/\b\w+\.(com|org|net|io|co|in)\b/gi, ' ');

  // Strip meta-instruction words commonly found in user AI prompts
  const cleaned = raw
    .replace(/\b(find|search|look\s+for|recent|latest|facebook|fb|posts?|groups?|threads?|write|create|give|generate|useful|contextual|responses?|comments?|reply|replies|mention|when|fits?|only|according\s+to|please|about|related\s+to|regarding|genuinely|genuine|fit|example|link|url)\b/gi, ' ')
    .replace(/[^\w\s#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Deduplicate words
  const words = [];
  const seen = new Set();
  for (const w of cleaned.split(' ')) {
    const lower = w.toLowerCase();
    if (lower.length > 2 && !seen.has(lower)) {
      seen.add(lower);
      words.push(w);
    }
  }

  const query = words.slice(0, 4).join(' ');
  return query || 'SaaS business growth';
}

function parseCount(text) {
  if (!text) return 0;
  const match = String(text).match(/([\d,.]+\s*[kKmM]?)/i);
  if (!match) return 0;
  let val = match[1].replace(/,/g, '').trim().toLowerCase();
  if (val.endsWith('k')) return parseFloat(val) * 1000;
  if (val.endsWith('m')) return parseFloat(val) * 1000000;
  return parseFloat(val) || 0;
}

function rank(candidates, picks) {
  const byId = new Map((picks || []).map((pick) => [String(pick.id), pick]));
  return candidates.map((candidate, index) => {
    const pick = byId.get(String(index + 1)) || {};
    let score = (Number(pick.relevance) || 0) * 0.6
      + (Number(pick.opportunity) || 0) * 0.2
      + (Number(pick.engagement) || 0) * 0.2;

    const likesNum = parseCount(candidate.upvotes);
    if (likesNum > 0) {
      score += Math.min(likesNum * 0.05, 2.0);
    }
    const commentsNum = parseCount(candidate.answers);
    if (commentsNum > 0) {
      score += Math.min(commentsNum * 0.05, 1.0);
    }
    return { ...candidate, score, reason: String(pick.reason || '').slice(0, 180) };
  }).sort((left, right) => right.score - left.score);
}

async function isLoggedIn(page) {
  const url = page.url();
  if (/\/login|login\.php|checkpoint/i.test(url)) return false;

  const indicators = [
    'div[aria-label="Your profile"]',
    'div[aria-label="Account controls and settings"]',
    'div[role="navigation"]',
    'a[aria-label="Facebook"]',
    'div[role="feed"]',
    'input[placeholder*="Search Facebook" i]',
    'div[aria-label*="Create a post" i]',
  ];

  for (const sel of indicators) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      return true;
    }
  }

  if (await page.locator('input[name="email"], button[name="login"]').first().isVisible().catch(() => false)) {
    return false;
  }

  return url.includes('facebook.com') && !url.includes('/login');
}

async function openSearch(page, query) {
  const searchUrl = `${HOME}/search/posts/?q=${encodeURIComponent(query)}`;
  await page.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForTimeout(3000);
  await page.mouse.wheel(0, 500).catch(() => {});
  await page.waitForTimeout(1500);
}

const EXTRACT_POST_LIMIT = 15;
const EXTRACT_SCROLL_ATTEMPTS = 6;

async function extractPostsFromDom(page) {
  return page.evaluate((limit) => {
    const cleanUrl = (href) => {
      if (!href) return '';
      const stripped = href.split('?')[0].split('&__cft__')[0].split('?__cft__')[0];
      return stripped;
    };

    const isPostHref = (href) => (
      /\/posts\//.test(href)
      || /permalink\.php/.test(href)
      || /\/permalink\//.test(href)
      || /story\.php/.test(href)
      || /\/videos\//.test(href)
      || /\/photos\//.test(href)
      || /\/watch\//.test(href)
    );

    const pickPostUrl = (root) => {
      const anchors = [...root.querySelectorAll('a[href]')];
      for (const a of anchors) {
        const href = a.href || '';
        if (isPostHref(href)) return cleanUrl(href);
      }
      return '';
    };

    const cardMeta = (root) => {
      const text = (root.innerText || '').replace(/\s+/g, ' ').trim();
      const commentMatch = text.match(/(\d+(?:\.\d+)?[kKmM]?)\s+comments?/i);
      const likeMatch = text.match(/(\d+(?:\.\d+)?[kKmM]?)\s+(?:likes?|reactions?|others)/i);
      return {
        text,
        commentMatch,
        likeMatch,
        hasCommentBtn: !!root.querySelector('[aria-label="Leave a comment"][role="button"]'),
      };
    };

    const pushCard = (found, seen, root) => {
      if (!root || root === document.body) return;
      const { text, commentMatch, likeMatch, hasCommentBtn } = cardMeta(root);
      if (text.length < 20) return;
      if (/sponsored|paid partnership/i.test(text.slice(0, 80))) return;

      const url = pickPostUrl(root);
      const dedupeKey = url || text.slice(0, 100);
      if (seen.has(dedupeKey)) return;
      if (!url && !hasCommentBtn) return;

      seen.add(dedupeKey);
      found.push({
        title: text.slice(0, 120),
        url: url || '',
        snippet: text.slice(0, 240),
        upvotes: likeMatch ? likeMatch[1] : '0',
        answers: commentMatch ? commentMatch[1] : '0',
      });
    };

    const found = [];
    const seen = new Set();
    const roots = [];

    // One card per visible "Leave a comment" (matches manual console flow)
    const commentButtons = [...document.querySelectorAll('[aria-label="Leave a comment"][role="button"]')];
    for (const btn of commentButtons) {
      let card = btn;
      for (let depth = 0; depth < 18 && card; depth += 1) {
        card = card.parentElement;
        if (!card || card === document.body) break;
        const url = pickPostUrl(card);
        const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
        if (url && text.length >= 25) {
          roots.push(card);
          break;
        }
      }
    }

    const feed = document.querySelector('div[role="feed"]');
    if (feed) {
      for (const child of feed.children) {
        if (child.querySelector('[aria-label="Leave a comment"]')) roots.push(child);
      }
    }

    for (const art of document.querySelectorAll('div[role="article"]')) {
      roots.push(art);
    }

    for (const root of roots) {
      pushCard(found, seen, root);
      if (found.length >= limit) return found;
    }

    // Search results: walk up from each post link to a compact card
    const links = [...document.querySelectorAll('a[href]')];
    for (const link of links) {
      const href = link.href || '';
      if (!isPostHref(href)) continue;
      let card = link.parentElement;
      for (let depth = 0; depth < 12 && card && card !== document.body; depth += 1) {
        const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 40 && text.length <= 4000) {
          pushCard(found, seen, card);
          break;
        }
        card = card.parentElement;
      }
      if (found.length >= limit) break;
    }

    return found;
  }, EXTRACT_POST_LIMIT);
}

async function extract(page) {
  const byUrl = new Map();

  for (let attempt = 0; attempt < EXTRACT_SCROLL_ATTEMPTS; attempt += 1) {
    const batch = await extractPostsFromDom(page);
    for (const row of batch) {
      const key = row.url || row.title;
      if (!key || byUrl.has(key)) continue;
      byUrl.set(key, row);
    }

    console.log(`[facebook] extract attempt ${attempt + 1}: ${batch.length} on page, ${byUrl.size} total unique`);
    if (byUrl.size >= EXTRACT_POST_LIMIT) break;

    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(1800);
  }

  const rows = [...byUrl.values()].slice(0, EXTRACT_POST_LIMIT);
  if (rows.length === 0) {
    console.log('[facebook] extract found no posts');
    return [];
  }

  const withUrl = rows.filter((row) => row.url);
  console.log(`[facebook] extract returning ${withUrl.length || rows.length} posts (${withUrl.length} with permalink)`);
  return withUrl.length ? withUrl : rows;
}

async function openQuestion(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  const postData = await page.evaluate(() => {
    const article = document.querySelector('div[role="article"]') || document.querySelector('div[role="main"]') || document.body;
    const text = (article?.innerText || '').replace(/\s+/g, ' ').trim();
    return { text: text.slice(0, 1000) };
  }).catch(() => ({ text: '' }));

  const title = postData.text.slice(0, 120) || 'Facebook Post';
  const body = `Facebook Post Content:\n${postData.text}`;

  return {
    title,
    body,
    isFacebook: true,
  };
}

const FB_STEP_DELAY_MS = 450;

async function fbPause(page, ms = FB_STEP_DELAY_MS) {
  await page.waitForTimeout(ms);
}

function commentAsEditor(page) {
  return page.getByRole('textbox', { name: /^Comment as\b/i }).last();
}

function postCommentButton(page) {
  return page.locator('#focused-state-composer-submit').getByRole('button', { name: 'Post comment' }).last();
}

async function rankedCommentButtons(page) {
  const feed = page.locator('div[role="feed"]').first();
  const hasFeed = await feed.count().catch(() => 0);
  const buttons = hasFeed
    ? feed.getByRole('button', { name: 'Leave a comment' })
    : page.getByRole('button', { name: 'Leave a comment' });
  const count = await buttons.count();
  const ranked = [];

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const meta = await button.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const feedNode = el.closest('div[role="feed"]');
      const article = el.closest('div[role="article"]');
      const countText = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const midpoint = (rect.top + rect.bottom) / 2;
      let score = 0;
      if (feedNode) score += 40;
      if (article && feedNode?.contains(article)) score += 20;
      if (/\d/.test(countText)) score += 30;
      if (el.querySelector('[data-ad-rendering-role="comment_button"]')) score += 20;
      if (rect.top >= 0 && rect.bottom <= window.innerHeight) score += 15;
      score -= Math.abs(midpoint - (window.innerHeight / 2)) / 40;
      return { score, top: Math.round(rect.top), countText: countText.slice(0, 24) };
    }).catch(() => null);
    if (!meta) continue;
    ranked.push({ button, ...meta });
  }

  ranked.sort((left, right) => right.score - left.score);
  return ranked;
}

async function openedCommentEditor(page) {
  const commentAs = commentAsEditor(page);
  if (await commentAs.isVisible().catch(() => false)) return commentAs;

  const dialogEditor = page.locator('div[role="dialog"] div[contenteditable="true"][data-lexical-editor="true"]').last();
  if (await dialogEditor.isVisible().catch(() => false)) return dialogEditor;

  const submitVisible = await page.locator('#focused-state-composer-submit').isVisible().catch(() => false);
  if (submitVisible) {
    const lexical = page.locator('div[contenteditable="true"][data-lexical-editor="true"]').last();
    if (await lexical.isVisible().catch(() => false)) return lexical;
  }
  return null;
}

async function editorPlainText(editor) {
  const raw = await editor.innerText().catch(() => '');
  return String(raw).replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
}

async function openCommentEditor(page) {
  const alreadyOpen = await openedCommentEditor(page);
  if (alreadyOpen) {
    console.log('[facebook] Comment popup is already open.');
    await fbPause(page);
    return alreadyOpen;
  }

  await fbPause(page);
  const ranked = await rankedCommentButtons(page);
  if (!ranked.length) throw new Error('Facebook comment button was not found in the feed');
  console.log(`[facebook] Found ${ranked.length} Leave a comment buttons in the feed.`);

  for (const target of ranked) {
    console.log(`[facebook] Clicking comment button at y=${target.top} text="${target.countText}"`);
    await target.button.scrollIntoViewIfNeeded().catch(() => {});
    await fbPause(page, 350);

    const icon = target.button.locator('[data-ad-rendering-role="comment_button"]').first();
    if (await icon.count().catch(() => 0)) {
      await icon.click({ force: true, timeout: 5000 }).catch(() => {});
    } else {
      await target.button.click({ timeout: 5000 }).catch(() => {});
    }
    await fbPause(page, 600);

    let editor = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      editor = await openedCommentEditor(page);
      if (editor) break;
      await fbPause(page, 400);
    }
    if (editor) {
      console.log('[facebook] Comment popup editor is visible.');
      await fbPause(page);
      return editor;
    }
    console.log('[facebook] This feed button did not open the comment box.');
  }

  throw new Error('Facebook comment popup did not open');
}

async function isPostCommentEnabled(page) {
  const btn = page.locator('#focused-state-composer-submit [aria-label="Post comment"]').last();
  const disabled = await btn.getAttribute('aria-disabled').catch(() => 'true');
  return disabled !== 'true';
}

async function focusLexicalEditor(page, editor) {
  await editor.scrollIntoViewIfNeeded().catch(() => {});
  await fbPause(page, 300);
  await editor.click({ timeout: 5000 });
  await fbPause(page, 250);
  await editor.evaluate((node) => {
    node.scrollIntoView({ block: 'center', behavior: 'instant' });
    node.focus();
    node.click();
    const paragraph = node.querySelector('p');
    if (!paragraph) return;
    paragraph.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await fbPause(page, 350);
}

async function lexicalPaste(page, editor, value) {
  return editor.evaluate((node, text) => {
    node.focus();
    const paragraph = node.querySelector('p') || node;
    paragraph.focus();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    node.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
    return (node.innerText || '').replace(/\s+/g, ' ').trim();
  }, value);
}

async function lexicalBeforeInput(page, editor, value) {
  return editor.evaluate((node, text) => {
    node.focus();
    const paragraph = node.querySelector('p') || node;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    for (const char of text) {
      const before = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: char,
      });
      node.dispatchEvent(before);
      if (!before.defaultPrevented) {
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
      }
    }
    return (node.innerText || '').replace(/\s+/g, ' ').trim();
  }, value);
}

async function typeIntoCommentEditor(page, editor, text) {
  const probe = text.slice(0, 24);
  await focusLexicalEditor(page, editor);

  console.log('[facebook] Pasting comment into Lexical editor...');
  let written = await lexicalPaste(page, editor, text);
  await fbPause(page, 500);
  if (probe && written.includes(probe) && await isPostCommentEnabled(page)) return written;

  console.log('[facebook] Paste incomplete; refocusing and pasting again...');
  await focusLexicalEditor(page, editor);
  written = await lexicalPaste(page, editor, text);
  await fbPause(page, 500);
  if (probe && written.includes(probe) && await isPostCommentEnabled(page)) return written;

  console.log('[facebook] Trying keyboard.type fallback...');
  await focusLexicalEditor(page, editor);
  await page.keyboard.type(text, { delay: 22 });
  await fbPause(page, 600);
  written = await editorPlainText(editor);
  if (probe && written.includes(probe) && await isPostCommentEnabled(page)) return written;

  console.log('[facebook] Trying beforeinput events...');
  await focusLexicalEditor(page, editor);
  written = await lexicalBeforeInput(page, editor, text);
  await fbPause(page, 500);
  if (probe && written.includes(probe)) return written;

  console.log('[facebook] Trying clipboard + Ctrl+V...');
  const context = page.context();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
  }, text).catch(() => {});
  await focusLexicalEditor(page, editor);
  await fbPause(page, 300);
  await page.keyboard.press('Control+V');
  await fbPause(page, 600);
  return editorPlainText(editor);
}

async function submitAnswer(page, comment) {
  const text = String(comment || '').replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Facebook comment is empty');

  console.log('[facebook] Starting comment submission flow...');
  await fbPause(page, 300);
  const editor = await openCommentEditor(page);
  await fbPause(page);
  const written = await typeIntoCommentEditor(page, editor, text);
  const probe = text.slice(0, 24);
  if (!written || !written.includes(probe)) {
    throw new Error('Facebook comment box did not accept the text');
  }
  console.log(`[facebook] Editor accepted the comment (${written.length} chars).`);
  await fbPause(page);

  const postButton = postCommentButton(page);
  console.log('[facebook] Waiting for Post comment to enable, then clicking it...');
  await postButton.waitFor({ state: 'visible', timeout: 8000 });
  await fbPause(page, 350);
  for (let wait = 0; wait < 24; wait += 1) {
    if (await isPostCommentEnabled(page)) break;
    await fbPause(page, 300);
  }
  if (!(await isPostCommentEnabled(page))) {
    throw new Error('Facebook Post comment stayed disabled after typing');
  }
  await fbPause(page, 400);
  await postButton.click({ timeout: 10000 });
  await fbPause(page, 800);

  const stillInEditor = await editorPlainText(editor).catch(() => '');
  if (stillInEditor.includes(probe)) {
    console.log('[facebook] Text is still in the box. Pressing Enter to post...');
    await editor.click({ timeout: 3000 }).catch(() => {});
    await fbPause(page, 350);
    await page.keyboard.press('Enter');
    await fbPause(page, 800);
  }

  await fbPause(page, 1200);
  console.log('[facebook] Comment submission completed.');
}

async function answerVisible(page, answer) {
  const cleanAnswer = answer.replace(/[*#_`]/g, '').replace(/\s+/g, ' ').trim();
  const sample = cleanAnswer.slice(0, 25);
  if (!sample) return false;

  for (let i = 0; i < 8; i++) {
    const found = await page.evaluate((snippet) => {
      let body = document.body?.innerText || '';
      const editors = Array.from(document.querySelectorAll('[contenteditable="true"]'));
      for (const editor of editors) {
        const chunk = editor.innerText || '';
        if (chunk) body = body.replace(chunk, ' ');
      }
      return body.replace(/\s+/g, ' ').includes(snippet);
    }, sample).catch(() => false);

    if (found) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function proofUrl(page, answer) {
  return page.url();
}

module.exports = {
  id: 'facebook',
  name: 'Facebook',
  homeUrl: `${HOME}/`,
  searchText,
  rank,
  isLoggedIn,
  openSearch,
  extract,
  openQuestion,
  submitAnswer,
  answerVisible,
  proofUrl,
};
