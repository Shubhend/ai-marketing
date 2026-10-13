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

async function extract(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await page.evaluate(() => {
      const found = [];
      const seen = new Set();

      // Method 1: Scan for articles or feed post units
      const articles = Array.from(document.querySelectorAll('div[role="article"], div[role="feed"] > div, div[data-pagelet*="FeedUnit"]'));

      for (const article of articles) {
        const text = (article.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length < 25) continue;
        if (/sponsored|paid partnership/i.test(text.slice(0, 80))) continue;

        // Look for permalink anchor inside this article
        const anchors = Array.from(article.querySelectorAll('a[href]'));
        let postUrl = null;

        for (const a of anchors) {
          const href = a.href || '';
          if (
            href.includes('/posts/') ||
            href.includes('/permalink.php') ||
            href.includes('/permalink/') ||
            href.includes('/photos/') ||
            href.includes('story.php')
          ) {
            postUrl = href.split('&__cft__')[0].split('?__cft__')[0];
            break;
          }
        }

        if (!postUrl) {
          // Check if any link points to a facebook status/post
          const matched = anchors.find((a) => /\/(?:posts|videos|photos)\//.test(a.href || ''));
          if (matched) postUrl = matched.href.split('?')[0];
        }

        if (!postUrl || seen.has(postUrl)) continue;
        seen.add(postUrl);

        const commentMatch = text.match(/(\d+(?:\.\d+)?[kKmM]?)\s+comments?/i);
        const likeMatch = text.match(/(\d+(?:\.\d+)?[kKmM]?)\s+(?:likes?|reactions?|others)/i);

        found.push({
          title: text.slice(0, 120),
          url: postUrl,
          snippet: text.slice(0, 240),
          upvotes: likeMatch ? likeMatch[1] : '0',
          answers: commentMatch ? commentMatch[1] : '0',
        });

        if (found.length >= 15) break;
      }

      // Method 2 fallback: If articles selector found nothing, scan post links
      if (found.length === 0) {
        const allLinks = Array.from(document.querySelectorAll('a[href]'));
        for (const link of allLinks) {
          const href = link.href || '';
          if (!href.includes('/posts/') && !href.includes('/permalink.php') && !href.includes('/permalink/')) continue;
          const clean = href.split('&__cft__')[0].split('?__cft__')[0];
          if (seen.has(clean)) continue;

          let card = link.parentElement;
          for (let i = 0; i < 10 && card && card !== document.body; i++) {
            if (card.innerText && card.innerText.length > 50) break;
            card = card.parentElement;
          }

          const cardText = (card?.innerText || link.innerText || '').replace(/\s+/g, ' ').trim();
          if (cardText.length < 25) continue;
          if (/sponsored/i.test(cardText.slice(0, 80))) continue;

          seen.add(clean);
          found.push({
            title: cardText.slice(0, 120),
            url: clean,
            snippet: cardText.slice(0, 240),
            upvotes: '0',
            answers: '0',
          });

          if (found.length >= 15) break;
        }
      }

      return found;
    });

    if (rows.length > 0) return rows;

    await page.mouse.wheel(0, 800).catch(() => {});
    await page.waitForTimeout(2000);
  }
  return [];
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
    return alreadyOpen;
  }

  const ranked = await rankedCommentButtons(page);
  if (!ranked.length) throw new Error('Facebook comment button was not found in the feed');
  console.log(`[facebook] Found ${ranked.length} Leave a comment buttons in the feed.`);

  for (const target of ranked) {
    console.log(`[facebook] Clicking comment button at y=${target.top} text="${target.countText}"`);
    await target.button.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);

    const icon = target.button.locator('[data-ad-rendering-role="comment_button"]').first();
    if (await icon.count().catch(() => 0)) {
      await icon.click({ force: true, timeout: 5000 }).catch(() => {});
    } else {
      await target.button.click({ timeout: 5000 }).catch(() => {});
    }

    let editor = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      editor = await openedCommentEditor(page);
      if (editor) break;
      await page.waitForTimeout(400);
    }
    if (editor) {
      console.log('[facebook] Comment popup editor is visible.');
      return editor;
    }
    console.log('[facebook] This feed button did not open the comment box.');
  }

  throw new Error('Facebook comment popup did not open');
}

async function typeIntoCommentEditor(page, editor, text) {
  const probe = text.slice(0, 24);
  await editor.scrollIntoViewIfNeeded().catch(() => {});

  const paragraph = editor.locator('p').first();
  if (await paragraph.isVisible().catch(() => false)) {
    await paragraph.click({ timeout: 5000 });
  } else {
    await editor.click({ timeout: 5000 });
  }
  await page.waitForTimeout(250);

  console.log('[facebook] Inserting comment text...');
  await page.keyboard.insertText(text);
  await page.waitForTimeout(500);

  let written = await editorPlainText(editor);
  if (probe && written.includes(probe)) return written;

  console.log('[facebook] insertText was not accepted. Typing with key events...');
  await editor.click({ timeout: 5000 });
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await editor.pressSequentially(text, { delay: 12 });
  await page.waitForTimeout(400);
  written = await editorPlainText(editor);
  if (probe && written.includes(probe)) return written;

  console.log('[facebook] Key events were not accepted. Trying Lexical insertText...');
  await editor.evaluate((node, value) => {
    node.focus();
    const target = node.querySelector('p') || node;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, value);
  }, text);
  await page.waitForTimeout(400);
  return editorPlainText(editor);
}

async function submitAnswer(page, comment) {
  const text = String(comment || '').replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Facebook comment is empty');

  console.log('[facebook] Starting comment submission flow...');
  const editor = await openCommentEditor(page);
  const written = await typeIntoCommentEditor(page, editor, text);
  const probe = text.slice(0, 24);
  if (!written || !written.includes(probe)) {
    throw new Error('Facebook comment box did not accept the text');
  }
  console.log(`[facebook] Editor accepted the comment (${written.length} chars).`);

  const postButton = postCommentButton(page);
  console.log('[facebook] Waiting for Post comment to enable, then clicking it...');
  await postButton.waitFor({ state: 'visible', timeout: 8000 });
  await postButton.click({ timeout: 10000 });
  await page.waitForTimeout(2000);

  const stillInEditor = await editorPlainText(editor).catch(() => '');
  if (stillInEditor.includes(probe)) {
    console.log('[facebook] Text is still in the box. Pressing Enter to post...');
    await editor.click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
  }

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
