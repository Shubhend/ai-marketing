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
    if (score <= 0 && candidate.url && (candidate.title || candidate.snippet)) {
      score = 1.25;
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
  await page.waitForTimeout(3500);
  await page.locator('div[role="feed"], a[href*="/posts/"], a[href*="permalink.php"]').first()
    .waitFor({ state: 'attached', timeout: 15000 })
    .catch(() => {});
  for (let scroll = 0; scroll < 3; scroll += 1) {
    await page.mouse.wheel(0, 700).catch(() => {});
    await page.waitForTimeout(1200);
  }
}

const EXTRACT_POST_LIMIT = 15;
const EXTRACT_SCROLL_ATTEMPTS = 6;

async function extractPostsFromDom(page) {
  return page.evaluate((limit) => {
    const canonicalPostUrl = (href) => {
      if (!href) return '';
      try {
        const u = new URL(href, 'https://www.facebook.com');
        if (/hashtag|\/search\//i.test(u.href)) return '';

        const path = u.pathname.replace(/\/+$/, '') || '/';
        const story = u.searchParams.get('story_fbid') || u.searchParams.get('fbid');
        const pageId = u.searchParams.get('id');

        if (/permalink\.php|story\.php|photo\.php/i.test(path)) {
          if (!story) return '';
          const idPart = pageId ? `&id=${pageId}` : '';
          return `${u.origin}${path}?story_fbid=${story}${idPart}`;
        }

        if (/\/groups\/[^/]+\/permalink\/\d+/i.test(path)) {
          return `${u.origin}${path}`;
        }
        if (/\/posts\/pfbid/i.test(path) || /\/posts\/\d+/i.test(path)) {
          return `${u.origin}${path}`;
        }
        if (/\/(videos|photos|reel|watch)\//i.test(path)) {
          return `${u.origin}${path}`;
        }

        return `${u.origin}${path}`.split('#')[0];
      } catch {
        return href.split('#')[0].split('&__cft__')[0];
      }
    };

    const isPostHref = (href) => {
      if (!href || /hashtag|\/search\//i.test(href)) return false;
      return (
        /\/posts\//.test(href)
        || /permalink\.php/.test(href)
        || /\/permalink\//.test(href)
        || /story\.php/.test(href)
        || /photo\.php/.test(href)
        || /\/videos\//.test(href)
        || /\/photos\//.test(href)
        || /\/watch\//.test(href)
        || /\/reel\//.test(href)
      );
    };

    const pickPostUrl = (root) => {
      const anchors = [...root.querySelectorAll('a[href]')].filter((a) => isPostHref(a.href));
      let best = '';
      let bestScore = -1;
      for (const a of anchors) {
        const href = canonicalPostUrl(a.href);
        if (!href) continue;
        let score = 0;
        if (/pfbid/i.test(href)) score += 12;
        if (/\/posts\//.test(href)) score += 8;
        if (/story_fbid=/i.test(href)) score += 10;
        if (/\/videos\//.test(href) || /\/photos\//.test(href)) score += 6;
        if (href.length > 45) score += 2;
        if (score > bestScore) {
          bestScore = score;
          best = href;
        }
      }
      return best;
    };

    const leaveCommentButtons = () => [...document.querySelectorAll('[aria-label="Leave a comment"][role="button"]')]
      .filter((el) => !el.closest('a[href]'));

    const minimalCardForButton = (btn) => {
      let card = btn.parentElement;
      let best = null;
      for (let depth = 0; depth < 30 && card && card !== document.body; depth += 1) {
        const inCard = leaveCommentButtons().filter((el) => card.contains(el));
        if (inCard.length > 1) break;
        const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
        const url = pickPostUrl(card);
        if (inCard.length === 1 && url && text.length >= 20 && text.length <= 8000) {
          best = card;
        }
        card = card.parentElement;
      }
      return best;
    };

    const cardToRow = (root) => {
      const text = (root.innerText || '').replace(/\s+/g, ' ').trim();
      const commentMatch = text.match(/(\d+(?:\.\d+)?[kKmM]?)\s+comments?/i);
      const likeMatch = text.match(/(\d+(?:\.\d+)?[kKmM]?)\s+(?:likes?|reactions?|others)/i);
      const url = pickPostUrl(root);
      return {
        title: text.slice(0, 120),
        url,
        snippet: text.slice(0, 240),
        upvotes: likeMatch ? likeMatch[1] : '0',
        answers: commentMatch ? commentMatch[1] : '0',
      };
    };

    const found = [];
    const seenUrls = new Set();
    const seenFallback = new Set();

    const pushRow = (row) => {
      if (!row) return;
      if (/sponsored|paid partnership/i.test((row.title || '').slice(0, 80))) return;
      if (row.url) {
        if (seenUrls.has(row.url)) return;
        seenUrls.add(row.url);
      } else {
        const fb = row.title.slice(0, 100);
        if (seenFallback.has(fb)) return;
        seenFallback.add(fb);
      }
      found.push(row);
    };

    const rowFromLink = (link) => {
      const url = canonicalPostUrl(link.href);
      if (!url) return null;

      let card = link.parentElement;
      let text = (link.innerText || '').replace(/\s+/g, ' ').trim();
      for (let depth = 0; depth < 14 && card && card !== document.body; depth += 1) {
        const chunk = (card.innerText || '').replace(/\s+/g, ' ').trim();
        if (chunk.length >= 35 && chunk.length <= 5000) {
          text = chunk;
          break;
        }
        card = card.parentElement;
      }
      if (text.length < 15) return null;

      const commentMatch = text.match(/(\d+(?:\.\d+)?[kKmM]?)\s+comments?/i);
      const likeMatch = text.match(/(\d+(?:\.\d+)?[kKmM]?)\s+(?:likes?|reactions?|others)/i);
      return {
        title: text.slice(0, 120),
        url,
        snippet: text.slice(0, 240),
        upvotes: likeMatch ? likeMatch[1] : '0',
        answers: commentMatch ? commentMatch[1] : '0',
      };
    };

    // 1) Search / feed: every unique canonical post link (fixes permalink.php dedupe)
    for (const link of document.querySelectorAll('a[href]')) {
      if (!isPostHref(link.href || '')) continue;
      pushRow(rowFromLink(link));
      if (found.length >= limit) return found;
    }

    // 2) One row per "Leave a comment" (smallest card that contains only that button)
    for (const btn of leaveCommentButtons()) {
      const card = minimalCardForButton(btn);
      if (!card) continue;
      pushRow(cardToRow(card));
      if (found.length >= limit) return found;
    }

    // 3) Feed children — one row per direct feed child with a comment action
    const feed = document.querySelector('div[role="feed"]');
    if (feed) {
      for (const child of feed.children) {
        if (!child.querySelector('[aria-label="Leave a comment"]')) continue;
        const row = cardToRow(child);
        if (row.url || row.title.length >= 25) pushRow(row);
        if (found.length >= limit) return found;
      }
    }

    return found;
  }, EXTRACT_POST_LIMIT);
}

async function extract(page) {
  const byUrl = new Map();
  const byTitle = new Map();

  for (let attempt = 0; attempt < EXTRACT_SCROLL_ATTEMPTS; attempt += 1) {
    const batch = await extractPostsFromDom(page);
    for (const row of batch) {
      if (row.url) {
        if (!byUrl.has(row.url)) byUrl.set(row.url, row);
      } else if (row.title) {
        const key = row.title.slice(0, 100);
        if (!byTitle.has(key)) byTitle.set(key, row);
      }
    }

    const total = byUrl.size + byTitle.size;
    console.log(`[facebook] extract attempt ${attempt + 1}: ${batch.length} on page, ${byUrl.size} with url, ${total} total unique`);
    if (byUrl.size >= EXTRACT_POST_LIMIT) break;

    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(1800);
  }

  const rows = [...byUrl.values(), ...byTitle.values()].slice(0, EXTRACT_POST_LIMIT);
  if (rows.length === 0) {
    console.log('[facebook] extract found no posts');
    return [];
  }

  const withUrl = rows.filter((row) => row.url);
  console.log(`[facebook] extract returning ${withUrl.length || rows.length} posts (${withUrl.length} with permalink)`);
  return withUrl.length ? withUrl : rows;
}

function isSinglePostView(url) {
  return /\/posts\/|permalink\.php|\/permalink\/|story\.php|\/photos\/|\/videos\/|\/watch\//i.test(url || '');
}

async function resolveTargetPostEngagement(page, postUrl) {
  const targetUrl = postUrl || page.url();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await page.evaluate((fullUrl) => {
      const clean = (href) => (href || '').split('#')[0];
      const pathOnly = (href) => clean(href).split('?')[0];

      const tokens = new Set();
      const raw = clean(fullUrl);
      tokens.add(pathOnly(raw));
      try {
        const u = new URL(raw);
        u.searchParams.forEach((value) => {
          if (value && /\d{5,}/.test(value)) tokens.add(value);
        });
      } catch {
        // ignore invalid URL
      }
      const pfbid = raw.match(/posts\/(pfbid[A-Za-z0-9_-]+)/i);
      if (pfbid) tokens.add(pfbid[1]);
      const postId = raw.match(/posts\/(\d{8,})/);
      if (postId) tokens.add(postId[1]);
      const perm = raw.match(/permalink\/(\d+)/);
      if (perm) tokens.add(perm[1]);

      const matchesPost = (href) => {
        const h = clean(href);
        if (!h || /hashtag|\/search\//i.test(h)) return false;
        const hp = pathOnly(h);
        for (const token of tokens) {
          if (!token) continue;
          if (h.includes(token) || hp.includes(token)) return true;
        }
        return false;
      };

      const isCommentAction = (el) => {
        if (!el || el.getAttribute('aria-label') !== 'Leave a comment') return false;
        if (el.getAttribute('role') !== 'button') return false;
        if (el.closest('a[href]')) return false;
        return true;
      };

      const commentButtons = [...document.querySelectorAll('[aria-label="Leave a comment"][role="button"]')]
        .filter(isCommentAction);

      let bestBtn = null;
      let bestCard = null;
      let bestScore = -1;

      for (const btn of commentButtons) {
        let card = btn.parentElement;
        let matched = false;
        for (let depth = 0; depth < 35 && card; depth += 1) {
          const anchors = card.querySelectorAll ? [...card.querySelectorAll('a[href]')] : [];
          for (const a of anchors) {
            if (matchesPost(a.href)) {
              matched = true;
              break;
            }
          }
          if (matched) break;
          card = card.parentElement;
        }

        const rect = btn.getBoundingClientRect();
        let score = 0;
        if (matched) score += 2000;
        if (btn.querySelector('[data-ad-rendering-role="comment_button"]')) score += 100;
        if (rect.width > 0 && rect.height > 0) score += 50;
        score += Math.max(0, 800 - rect.top);
        if (btn.closest('div[role="main"]')) score += 30;

        if (score > bestScore) {
          bestScore = score;
          bestBtn = btn;
          bestCard = card || btn.closest('div[role="main"]') || btn.parentElement;
        }
      }

      if (!bestBtn && commentButtons.length) {
        bestBtn = commentButtons[0];
        bestCard = bestBtn.closest('div[role="main"]') || bestBtn.parentElement;
        bestScore = 1;
      }

      document.querySelectorAll('[data-fb-target-post]').forEach((el) => el.removeAttribute('data-fb-target-post'));
      document.querySelectorAll('[data-fb-target-comment]').forEach((el) => el.removeAttribute('data-fb-target-comment'));

      if (!bestBtn) {
        return { marked: false, buttonCount: commentButtons.length };
      }

      if (bestCard) bestCard.setAttribute('data-fb-target-post', '1');
      bestBtn.setAttribute('data-fb-target-comment', '1');

      const rect = bestBtn.getBoundingClientRect();
      return {
        marked: true,
        buttonCount: commentButtons.length,
        score: bestScore,
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }, targetUrl).catch(() => ({ marked: false }));

    if (result?.marked) {
      console.log(`[facebook] Resolved comment target: ${JSON.stringify(result)}`);
      return result;
    }

    await page.mouse.wheel(0, 350).catch(() => {});
    await page.waitForTimeout(600);
  }

  console.log('[facebook] Could not resolve a comment button for this post URL');
  return { marked: false };
}

async function openQuestion(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  await resolveTargetPostEngagement(page, url);
  await page.waitForTimeout(500);

  const postData = await page.evaluate(() => {
    const article = document.querySelector('[data-fb-target-post="1"]')
      || document.querySelector('div[role="article"]')
      || document.querySelector('div[role="main"]')
      || document.body;
    const text = (article?.innerText || '').replace(/\s+/g, ' ').trim();
    return { text: text.slice(0, 1000) };
  }).catch(() => ({ text: '' }));

  const title = postData.text.slice(0, 120) || 'Facebook Post';
  const body = `Facebook Post Content:\n${postData.text}`;

  return {
    title,
    body,
    isFacebook: true,
    postUrl: url,
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

function postCommentActionSelector() {
  return 'div[aria-label="Leave a comment"][role="button"]:has([data-ad-rendering-role="comment_button"])';
}

async function isValidPostCommentButton(button) {
  return button.evaluate((el) => {
    if (el.getAttribute('aria-label') !== 'Leave a comment') return false;
    if (el.getAttribute('role') !== 'button') return false;
    if (el.closest('a[href]')) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).catch(() => false);
}

async function clickLeaveCommentButton(page, button) {
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await fbPause(page, 350);

  await button.evaluate((el) => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const target = el.querySelector('[data-ad-rendering-role="comment_button"]') || el;
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
  });
}

async function waitForCommentEditor(page) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const editor = await openedCommentEditor(page);
    if (editor) return editor;
    await fbPause(page, 400);
  }
  return null;
}

async function openCommentOnTargetPost(page, postUrl) {
  let button = page.locator('[data-fb-target-comment="1"]').first();
  if (!(await button.count().catch(() => 0))) {
    await resolveTargetPostEngagement(page, postUrl || page.url());
    button = page.locator('[data-fb-target-comment="1"]').first();
  }
  if (!(await button.count().catch(() => 0))) {
    console.log('[facebook] No tagged comment button on page.');
    return null;
  }
  if (!(await button.isVisible().catch(() => false))) {
    console.log('[facebook] Tagged comment button is not visible.');
    return null;
  }
  if (!(await isValidPostCommentButton(button))) {
    console.log('[facebook] Tagged comment button failed validation.');
    return null;
  }

  console.log('[facebook] Clicking tagged Leave a comment button (no page coordinates).');
  await clickLeaveCommentButton(page, button);
  await fbPause(page, 600);
  const editor = await waitForCommentEditor(page);
  if (editor) {
    console.log('[facebook] Comment popup opened from target post.');
    await fbPause(page);
  }
  return editor;
}

async function rankedCommentButtons(page) {
  const scopedRoot = page.locator('[data-fb-target-post="1"]').first();
  const useScoped = (await scopedRoot.count().catch(() => 0)) > 0;
  const container = useScoped ? scopedRoot : page.locator('div[role="feed"]').first();
  const hasContainer = await container.count().catch(() => 0);
  const tagged = page.locator('[data-fb-target-comment="1"]').first();
  if (await tagged.count().catch(() => 0)) {
    if (await tagged.isVisible().catch(() => false) && await isValidPostCommentButton(tagged)) {
      return [{ button: tagged, score: 9999, top: 0, countText: 'tagged' }];
    }
  }

  const buttons = (hasContainer ? container : page).locator(
    `${postCommentActionSelector()}, [aria-label="Leave a comment"][role="button"]`,
  );
  const count = await buttons.count();
  const ranked = [];

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    if (!(await isValidPostCommentButton(button))) continue;

    const meta = await button.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const inTarget = !!el.closest('[data-fb-target-post="1"]');
      const countText = (el.innerText || '').replace(/\s+/g, ' ').trim();
      let score = 0;
      if (inTarget) score += 200;
      if (/\d/.test(countText)) score += 20;
      if (rect.top >= 0 && rect.top < window.innerHeight * 0.75) score += 25;
      score -= rect.top / 100;
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

  const postUrl = page.url();
  if (isSinglePostView(postUrl) || (await page.locator('[data-fb-target-comment="1"]').count())) {
    const fromTarget = await openCommentOnTargetPost(page, postUrl);
    if (fromTarget) return fromTarget;
  }
  if (isSinglePostView(postUrl)) {
    await resolveTargetPostEngagement(page, postUrl);
    await fbPause(page, 400);
    const retryTarget = await openCommentOnTargetPost(page, postUrl);
    if (retryTarget) return retryTarget;
  }

  const ranked = await rankedCommentButtons(page);
  if (!ranked.length) throw new Error('Facebook post comment action was not found');
  console.log(`[facebook] Found ${ranked.length} valid comment actions.`);

  for (const target of ranked) {
    console.log(`[facebook] Clicking comment action at y=${target.top} text="${target.countText}" score=${target.score}`);
    await clickLeaveCommentButton(page, target.button);
    await fbPause(page, 600);

    const editor = await waitForCommentEditor(page);
    if (editor) {
      console.log('[facebook] Comment popup editor is visible.');
      await fbPause(page);
      return editor;
    }
    console.log('[facebook] This comment action did not open the comment box.');
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
  await resolveTargetPostEngagement(page, page.url());
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
