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

  // Remove URLs and domain names
  raw = raw.replace(/https?:\/\/\S+/gi, ' ').replace(/\b\w+\.(com|org|net|io|co|in)\b/gi, ' ');

  // Strip meta-instruction words commonly found in user AI prompts
  const cleaned = raw
    .replace(/\b(find|search|look\s+for|recent|latest|quora|questions?|discussions?|threads?|posts?|write|create|give|generate|useful|contextual|responses?|answers?|comments?|reply|mention|when|fits?|only|according\s+to|please|about|related\s+to|regarding|genuinely|genuine|fit|example|link|url)\b/gi, ' ')
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
    // Bonus to questions with visible community votes or answers to comment on
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

async function openSearch(page, query) {
  await page.goto(`${HOME}/search?q=${encodeURIComponent(query)}&type=question`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  // Wait for Quora React app to render search items
  await page.waitForTimeout(3000);
  await page.mouse.wheel(0, 500).catch(() => {});
  await page.waitForTimeout(1500);
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

        // Question slugs typically have at least one hyphen and reasonable length
        const cleanSlug = path.replace(/^\/unanswered\//, '').replace(/^\//, '');
        if (cleanSlug.length < 8 || !cleanSlug.includes('-')) continue;

        // Title from the link or inside span
        const rawTitle = (link.innerText || link.textContent || cleanSlug.replace(/-/g, ' '))
          .replace(/\s+/g, ' ')
          .trim();

        // Must have at least 12 characters to be a real question title
        if (rawTitle.length < 12) continue;

        // Skip utility buttons/links
        if (/^(log in|sign up|follow|answer|share|request|downvote|upvote|comment|more)$/i.test(rawTitle)) {
          continue;
        }

        const cleanUrl = `https://www.quora.com${path}`;
        if (seen.has(cleanUrl)) continue;
        seen.add(cleanUrl);

        // Find card container by walking up
        let card = link.parentElement;
        let upvoteBtn = null;
        for (let i = 0; i < 10 && card && card !== document.body; i++) {
          upvoteBtn = card.querySelector('.puppeteer_test_votable_upvote_button') ||
                      card.querySelector('button[aria-label="Upvote"]') ||
                      card.querySelector('button[aria-label*="pvote"]');
          if (upvoteBtn) break;
          card = card.parentElement;
        }

        // Extract upvotes from upvote button using exact Quora inner spans
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

        // Extract answers count if present
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

    // Scroll down and wait in case page is still hydrating
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

  // Extract top post / top answer content so AI can craft a context-aware comment
  const topAnswer = await page.evaluate(() => {
    const answerContainers = document.querySelectorAll('.puppeteer_test_answer_content, .q-box.qu-pt--medium, .qu-userSelect--text');
    for (const el of answerContainers) {
      const text = (el.innerText || '').trim();
      if (text.length > 40 && !text.includes('Add question') && !text.includes('Try Quora+')) {
        return text.slice(0, 900);
      }
    }
    return '';
  }).catch(() => '');

  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 1000);

  return {
    title: title || body.slice(0, 140),
    topAnswer,
    body: topAnswer ? `Discussion Question: ${title}\nTop Post to comment on:\n${topAnswer}` : body,
    isComment: true,
  };
}

async function submitAnswer(page, comment) {
  // Instead of answering the question, post a comment on the top post/answer

  // 1. Check if comment editor is already open on the page
  let editor = page.locator('div.doc[contenteditable="true"], div[contenteditable="true"]').first();
  let editorVisible = await editor.isVisible().catch(() => false);

  if (!editorVisible) {
    // Locate the comment button on the top post
    const commentSelectors = [
      'button[aria-label*="comment" i]',
      'button.puppeteer_test_comment_button',
      'button:has-text("Comment")',
      'div[role="button"][aria-label*="comment" i]',
    ];

    let clicked = false;
    for (const sel of commentSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(300);
        await btn.click().catch(() => {});
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Scroll down slightly to make sure answers are loaded and retry
      await page.mouse.wheel(0, 400).catch(() => {});
      await page.waitForTimeout(1000);
      const btn = page.locator('button[aria-label*="comment" i]').first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click().catch(() => {});
        clicked = true;
      }
    }

    if (!clicked) {
      throw new Error('Could not find comment button on the top post (question may have no answers yet)');
    }
  }

  // 2. Wait for the comment editor to appear
  const editorSelectors = [
    'div.doc[contenteditable="true"]',
    'div[contenteditable="true"]',
    'div[role="textbox"]',
  ];

  let activeEditor = null;
  for (let i = 0; i < 20; i++) {
    for (const sel of editorSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        activeEditor = loc;
        break;
      }
    }
    if (activeEditor) break;
    await page.waitForTimeout(500);
  }

  if (!activeEditor) {
    activeEditor = page.locator('div[contenteditable="true"]').first();
    await activeEditor.waitFor({ state: 'visible', timeout: 10000 });
  }

  // 3. Focus and insert comment
  await activeEditor.scrollIntoViewIfNeeded().catch(() => {});
  await activeEditor.click();
  await page.waitForTimeout(400);

  await page.keyboard.insertText(comment);
  await page.waitForTimeout(500);

  const currentContent = (await activeEditor.innerText().catch(() => '')).trim();
  if (!currentContent) {
    await activeEditor.fill(comment).catch(() => {});
  }
  await page.waitForTimeout(1000);

  // 4. Click the Post button for this comment
  const submitSelectors = [
    'button.puppeteer_test_modal_submit',
    'button:has-text("Post")',
    'button:has-text("Add comment")',
    'button[type="submit"]',
  ];

  let posted = false;
  for (const sel of submitSelectors) {
    const pBtn = page.locator(sel).first();
    if (await pBtn.isVisible().catch(() => false)) {
      for (let w = 0; w < 10; w++) {
        if (!(await pBtn.isDisabled().catch(() => true))) break;
        await page.waitForTimeout(300);
      }
      await pBtn.click().catch(() => {});
      posted = true;
      break;
    }
  }

  if (!posted) {
    await page.getByRole('button', { name: /^(Post|Add comment)$/i }).first().click().catch(() => {});
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
  id: 'quora-comment',
  name: 'Quora Comment',
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
