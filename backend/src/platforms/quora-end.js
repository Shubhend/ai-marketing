const HOME = 'https://www.quora.com';

function searchText(prompt, content) {
  let raw = '';
  if (typeof content === 'object' && content?.title) {
    raw = `${content.title} ${content.text || ''}`;
  } else if (typeof content === 'string' && content !== prompt) {
    raw = `${prompt || ''} ${content}`;
  } else {
    raw = prompt || '';
  }

  // If user explicitly specifies a line like "Search in Quora\nkeyword 1\nkeyword 2", prioritize the first focused line
  const searchMatch = raw.match(/search(?:\s+in\s+quora)?[\s:]*\n+([^\n]+)/i);
  if (searchMatch && searchMatch[1]?.trim()) {
    const candidateLine = searchMatch[1].replace(/https?:\/\/\S+/gi, '').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (candidateLine.length >= 3 && candidateLine.split(' ').length <= 5) {
      return candidateLine;
    }
  }

  // Remove URLs and domain names
  raw = raw.replace(/https?:\/\/\S+/gi, ' ').replace(/\b\w+\.(com|org|net|io|co|in)\b/gi, ' ');

  // Strip meta-instruction words commonly found in user AI prompts
  const cleaned = raw
    .replace(/\b(find|search|look\s+for|recent|latest|quora|questions?|discussions?|threads?|posts?|write|create|give|generate|useful|contextual|responses?|answers?|comments?|reply|end|bottom|mention|when|fits?|only|according\s+to|please|about|related\s+to|regarding|genuinely|genuine|fit|example|link|url)\b/gi, ' ')
    .replace(/[^\w\s]/g, ' ')
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
  return query || 'fitness health';
}

function metric(text, label) {
  const match = String(text).match(new RegExp(`([\\d,.]+\\s*[kKmM]?)\\s+${label}`, 'i'));
  return match ? match[1].replace(/\s+/g, '').toLowerCase() : null;
}

function withMetrics(item) {
  const recency = String(item.snippet).match(/\b(\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago|yesterday|today)\b/i);
  return {
    ...item,
    answers: item.answers || metric(item.snippet, 'answers?'),
    upvotes: item.upvotes || metric(item.snippet, 'upvotes?'),
    views: item.views || metric(item.snippet, 'views?'),
    followers: item.followers || metric(item.snippet, 'followers?'),
    recency: item.recency || (recency ? recency[1] : null),
  };
}

function rank(candidates, picks) {
  const byId = new Map((picks || []).map((pick) => [String(pick.id), pick]));
  return candidates.map((candidate, index) => {
    const pick = byId.get(String(index + 1)) || {};
    let score = (Number(pick.relevance) || 0) * 0.6
      + (Number(pick.opportunity) || 0) * 0.2
      + (Number(pick.engagement) || 0) * 0.2;
    // Bonus for discussions with active answers
    const votesNum = parseFloat(String(candidate.upvotes || '0').replace(/k/i, '000').replace(/m/i, '000000'));
    if (votesNum > 0) {
      score += Math.min(votesNum * 0.05, 2.0);
    }
    const ansNum = parseFloat(String(candidate.answers || '0').replace(/k/i, '000').replace(/m/i, '000000'));
    if (ansNum > 0) {
      score += Math.min(ansNum * 0.05, 1.0);
    }
    return { ...candidate, score, reason: String(pick.reason || '').slice(0, 180) };
  }).sort((left, right) => right.score - left.score);
}

async function isLoggedIn(page) {
  const url = page.url();
  if (/\/login|\/signup/i.test(url)) return false;
  if (await page.getByRole('button', { name: /add question/i }).first().isVisible().catch(() => false)) return true;
  if (await page.getByRole('button', { name: /log in/i }).first().isVisible().catch(() => false)) return false;
  return url.startsWith(HOME);
}

function buildRandomSearchUrl(cleanQuery, options = {}) {
  if (options && (options.time || options.sortOrder)) {
    const params = new URLSearchParams({ q: cleanQuery, type: 'question' });
    if (options.sortOrder) params.set('sortOrder', options.sortOrder);
    if (options.time) params.set('time', options.time);
    return {
      url: `${HOME}/search?${params.toString()}`,
      strategy: { sortOrder: options.sortOrder || null, time: options.time || null, label: 'explicit filter' },
    };
  }

  const strategies = [
    { sortOrder: 'time_descending', time: 'day', label: 'past day, newest first' },
    { sortOrder: 'time_descending', time: 'week', label: 'past week, newest first' },
    { sortOrder: 'time_descending', time: 'month', label: 'past month, newest first' },
    { sortOrder: 'time_descending', time: null, label: 'all-time, newest first' },
    { sortOrder: null, time: 'day', label: 'past day, top relevant' },
    { sortOrder: null, time: 'week', label: 'past week, top relevant' },
    { sortOrder: null, time: 'month', label: 'past month, top relevant' },
    { sortOrder: null, time: null, label: 'all-time, default relevance (no filters)' },
  ];

  const picked = strategies[Math.floor(Math.random() * strategies.length)];
  const params = new URLSearchParams({ q: cleanQuery, type: 'question' });
  if (picked.sortOrder) params.set('sortOrder', picked.sortOrder);
  if (picked.time) params.set('time', picked.time);

  console.log(`[quora-end] Randomized search filter selected: "${picked.label}" (${params.toString()})`);
  return {
    url: `${HOME}/search?${params.toString()}`,
    strategy: picked,
  };
}

async function openSearch(page, query) {
  const cleanQuery = typeof query === 'string' ? query : query?.text || '';
  const queryOptions = typeof query === 'object' && query !== null ? query : {};
  const { url, strategy } = buildRandomSearchUrl(cleanQuery, queryOptions);

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
  } catch (err) {
    console.warn(`[quora-end] Direct filtered search failed (${err?.message || err}), falling back...`);
    await page.goto(`${HOME}/search?q=${encodeURIComponent(cleanQuery)}&type=question`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
  }

  await page.waitForTimeout(3000);
  await page.mouse.wheel(0, 500).catch(() => {});
  await page.waitForTimeout(1500);

  const hasResults = await page.locator('a[href*="/"]').count().catch(() => 0);
  if (hasResults <= 3 && (strategy?.time || strategy?.sortOrder)) {
    console.log(`[quora-end] Few results found with "${strategy.label}" for "${cleanQuery}". Widening to standard search...`);
    const fallbackUrl = `${HOME}/search?q=${encodeURIComponent(cleanQuery)}&type=question`;
    await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
}

async function extract(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await page.evaluate(() => {
      const found = [];
      const seen = new Set();
      const links = document.querySelectorAll('a[href]');

      const blockedPrefixes = [
        '/search', '/profile', '/topic', '/space', '/about', '/press',
        '/careers', '/terms', '/privacy', '/contact', '/directory',
        '/messages', '/notifications', '/home', '/settings', '/answer/',
      ];

      for (const link of links) {
        let url;
        try {
          url = new URL(link.href, location.origin);
        } catch {
          continue;
        }
        if (url.hostname !== 'www.quora.com' && url.hostname !== 'quora.com') continue;

        const path = url.pathname;
        if (path === '/' || blockedPrefixes.some((p) => path.startsWith(p))) {
          continue;
        }

        const cleanSlug = path.replace(/^\/unanswered\//, '').replace(/^\//, '');
        if (cleanSlug.length < 8 || !cleanSlug.includes('-')) continue;

        const rawTitle = (link.innerText || link.textContent || cleanSlug.replace(/-/g, ' '))
          .replace(/\s+/g, ' ')
          .trim();

        if (rawTitle.length < 12) continue;
        if (/^(log in|sign up|follow|answer|share|request|downvote|upvote|comment|more)$/i.test(rawTitle)) {
          continue;
        }

        const cleanUrl = `https://www.quora.com${path}`;
        if (seen.has(cleanUrl)) continue;
        seen.add(cleanUrl);

        let card = link.parentElement;
        let upvoteBtn = null;
        for (let i = 0; i < 10 && card && card !== document.body; i++) {
          upvoteBtn = card.querySelector('.puppeteer_test_votable_upvote_button') ||
                      card.querySelector('button[aria-label="Upvote"]') ||
                      card.querySelector('button[aria-label*="pvote"]');
          if (upvoteBtn) break;
          card = card.parentElement;
        }

        let upvotes = null;
        if (upvoteBtn) {
          const btnTextContainer = upvoteBtn.querySelector('.puppeteer_test_button_text') || upvoteBtn;
          const visibleCountSpan = btnTextContainer.querySelector('span[style*="position: absolute"]') ||
                                   btnTextContainer.querySelector('.qu-whiteSpace--nowrap:not(.qu-visibility--hidden)');
          if (visibleCountSpan && visibleCountSpan.innerText && /\d/.test(visibleCountSpan.innerText)) {
            upvotes = visibleCountSpan.innerText.trim();
          } else {
            const rawBtnText = (btnTextContainer.innerText || btnTextContainer.textContent || '')
              .replace(/upvote/gi, '')
              .replace(/[·•]/g, ' ')
              .trim();
            const matches = rawBtnText.match(/(\d+(?:\.\d+)?[kKmM]?)/g);
            if (matches && matches.length > 0) {
              upvotes = matches[matches.length - 1];
            }
          }
        }

        let answers = null;
        const cardText = card?.innerText || '';
        const ansMatch = cardText.match(/(\d+(?:\.\d+)?[kKmM]?)\s+answers?/i);
        if (ansMatch) answers = ansMatch[1];

        const snippet = (cardText || rawTitle).replace(/\s+/g, ' ').trim().slice(0, 240);

        found.push({
          title: rawTitle.slice(0, 180),
          url: cleanUrl,
          snippet,
          upvotes,
          answers,
        });

        if (found.length >= 15) break;
      }
      return found;
    });

    if (rows.length > 0) {
      return rows.map(withMetrics);
    }

    await page.mouse.wheel(0, 800).catch(() => {});
    await page.waitForTimeout(2000);
  }
  return [];
}

async function openQuestion(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);

  const title = (await page.locator('h1').first().innerText().catch(() => '')) ||
    (await page.locator('.puppeteer_test_question_title').first().innerText().catch(() => '')).trim();

  // Scroll down a bit to inspect the latest / bottom posts at the end of the thread
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(500);
  }

  // Extract text from the last post at the end of the discussion
  const endPostText = await page.evaluate(() => {
    const containers = Array.from(document.querySelectorAll('.puppeteer_test_answer_content, .q-box.qu-pt--medium, .qu-userSelect--text'));
    const valid = containers
      .map((el) => (el.innerText || '').trim())
      .filter((t) => t.length > 30 && !t.includes('Add question') && !t.includes('Try Quora+'));
    return valid.length > 0 ? valid[valid.length - 1].slice(0, 800) : '';
  }).catch(() => '');

  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 1000);

  return {
    title: title || body.slice(0, 140),
    endPost: endPostText,
    body: endPostText ? `Discussion Question: ${title}\nPost at end of thread:\n${endPostText}` : body,
    isEnd: true,
  };
}

async function submitAnswer(page, answer) {
  // Give answer/reply at the end of the discussion thread

  // Scroll down to load answers towards the bottom
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 1000).catch(() => {});
    await page.waitForTimeout(600);
  }

  // 1. Locate comment/reply button on the post at the end
  const commentButtons = page.locator('button[aria-label*="comment" i], button.puppeteer_test_comment_button');
  const count = await commentButtons.count();

  let clicked = false;
  if (count > 0) {
    const lastCommentBtn = commentButtons.last();
    if (await lastCommentBtn.isVisible().catch(() => false)) {
      await lastCommentBtn.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);
      await lastCommentBtn.click().catch(() => {});
      clicked = true;
    }
  }

  // Fallback: If no comment button exists (e.g. question has no answers yet), use the main answer button
  if (!clicked) {
    const answerSelectors = [
      'button.puppeteer_test_answer_button',
      'button:has-text("Answer")',
      '[aria-label="Answer"]',
      'div[role="button"]:has-text("Answer")',
    ];
    for (const sel of answerSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        clicked = true;
        break;
      }
    }
  }

  // 2. Wait for the contenteditable editor
  const editorSelectors = [
    'div.doc[contenteditable="true"]',
    'div[contenteditable="true"]',
    'div[role="textbox"]',
  ];

  let editor = null;
  for (let i = 0; i < 20; i++) {
    for (const sel of editorSelectors) {
      const loc = page.locator(sel).last();
      if (await loc.isVisible().catch(() => false)) {
        editor = loc;
        break;
      }
    }
    if (editor) break;
    await page.waitForTimeout(500);
  }

  if (!editor) {
    editor = page.locator('div[contenteditable="true"]').last();
    await editor.waitFor({ state: 'visible', timeout: 10000 });
  }

  // 3. Focus and insert answer
  await editor.scrollIntoViewIfNeeded().catch(() => {});
  await editor.click();
  await page.waitForTimeout(400);

  await page.keyboard.insertText(answer);
  await page.waitForTimeout(500);

  const currentContent = (await editor.innerText().catch(() => '')).trim();
  if (!currentContent) {
    await editor.fill(answer).catch(() => {});
  }
  await page.waitForTimeout(1000);

  // 4. Submit
  const submitSelectors = [
    'button.puppeteer_test_modal_submit',
    'button:has-text("Post")',
    'button:has-text("Submit")',
    'button:has-text("Add comment")',
    'button[type="submit"]',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    const sBtn = page.locator(sel).last();
    if (await sBtn.isVisible().catch(() => false)) {
      for (let w = 0; w < 10; w++) {
        if (!(await sBtn.isDisabled().catch(() => true))) break;
        await page.waitForTimeout(300);
      }
      await sBtn.click().catch(() => {});
      submitted = true;
      break;
    }
  }

  if (!submitted) {
    await page.getByRole('button', { name: /^(Post|Submit|Add comment)$/i }).last().click().catch(() => {});
  }

  await page.waitForTimeout(4000);
}

async function answerVisible(page, answer) {
  const cleanAnswer = answer.replace(/[*#_`]/g, '').replace(/\s+/g, ' ').trim();
  const sample = cleanAnswer.slice(0, 30);
  if (!sample) return false;

  for (let i = 0; i < 8; i++) {
    const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (bodyText.includes(sample)) {
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function proofUrl(page, answer) {
  const cleanAnswer = answer.replace(/[*#_`]/g, '').replace(/\s+/g, ' ').trim();
  const sample = cleanAnswer.slice(0, 24);
  const found = await page.evaluate((snippet) => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/comment/"], a[href*="/answer/"]'));
    const matched = anchors.find((a) => (a.innerText || '').includes(snippet) || (a.closest('.q-box')?.innerText || '').includes(snippet));
    return matched?.href || null;
  }, sample).catch(() => null);

  return found || page.url();
}

module.exports = {
  id: 'quora-end',
  name: 'Quora Answer at End',
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
