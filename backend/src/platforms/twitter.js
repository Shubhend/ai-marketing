const HOME = 'https://x.com';

function searchText(prompt, content) {
  let raw = '';
  if (typeof content === 'object' && content?.title) {
    raw = `${content.title} ${content.text || ''}`;
  } else if (typeof content === 'string' && content !== prompt) {
    raw = `${prompt || ''} ${content}`;
  } else {
    raw = prompt || '';
  }

  // If user explicitly specifies a line like "Search in Twitter\nkeyword 1", prioritize the first focused line
  const searchMatch = raw.match(/search(?:\s+in\s+(?:twitter|x))?[\s:]*\n+([^\n]+)/i);
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
    .replace(/\b(find|search|look\s+for|recent|latest|twitter|tweets?|x\.com|threads?|posts?|write|create|give|generate|useful|contextual|responses?|comments?|reply|replies|mention|when|fits?|only|according\s+to|please|about|related\s+to|regarding|genuinely|genuine|fit|example|link|url)\b/gi, ' ')
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
  return query || 'SaaS marketing';
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
    const repliesNum = parseCount(candidate.answers);
    if (repliesNum > 0) {
      score += Math.min(repliesNum * 0.05, 1.0);
    }
    return { ...candidate, score, reason: String(pick.reason || '').slice(0, 180) };
  }).sort((left, right) => right.score - left.score);
}

async function isLoggedIn(page) {
  const url = page.url();
  if (/\/login|\/i\/flow\/login|\/signup/i.test(url)) return false;

  const indicators = [
    '[data-testid="AppTabBar_Home_Link"]',
    '[data-testid="SideNav_AccountSwitcher_Button"]',
    '[data-testid="primaryColumn"]',
    'a[href="/home"]',
    '[data-testid="tweetButtonInline"]',
  ];

  for (const sel of indicators) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      return true;
    }
  }

  if (await page.locator('[data-testid="loginButton"], a[href="/login"]').first().isVisible().catch(() => false)) {
    return false;
  }

  return url.includes('x.com') || url.includes('twitter.com');
}

async function openSearch(page, query) {
  const searchUrl = `${HOME}/search?q=${encodeURIComponent(query)}&src=typed_query&f=top`;
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
      const articles = document.querySelectorAll('article[data-testid="tweet"]');

      for (const article of articles) {
        const cardText = (article.innerText || '').trim();

        // Skip ads / promoted tweets
        if (/promoted/i.test(cardText) || article.querySelector('[data-testid="placementTracking"]')) {
          continue;
        }

        // Find status URL
        const anchors = Array.from(article.querySelectorAll('a[href*="/status/"]'));
        let cleanUrl = null;
        let authorHandle = '';

        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const match = href.match(/\/([A-Za-z0-9_]+)\/status\/(\d+)/);
          if (match) {
            authorHandle = `@${match[1]}`;
            cleanUrl = `https://x.com/${match[1]}/status/${match[2]}`;
            break;
          }
        }

        if (!cleanUrl || seen.has(cleanUrl)) continue;
        seen.add(cleanUrl);

        // Tweet text
        const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
        const text = (tweetTextEl?.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length < 15) continue;

        // Parse metrics
        const parseMetric = (testId) => {
          const el = article.querySelector(`[data-testid="${testId}"]`);
          if (!el) return null;
          const aria = el.getAttribute('aria-label') || '';
          const numMatch = aria.match(/([\d,.]+\s*[kKmM]?)/) || (el.innerText || '').match(/([\d,.]+\s*[kKmM]?)/);
          return numMatch ? numMatch[1].replace(/,/g, '') : null;
        };

        const replies = parseMetric('reply');
        const retweets = parseMetric('retweet');
        const likes = parseMetric('like');

        const title = `${authorHandle}: ${text.slice(0, 120)}`;
        found.push({
          title,
          url: cleanUrl,
          snippet: text.slice(0, 240),
          upvotes: likes || '0',
          answers: replies || '0',
          retweets: retweets || '0',
          author: authorHandle,
        });

        if (found.length >= 15) break;
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
  await page.waitForTimeout(2500);

  const mainTweet = await page.evaluate(() => {
    const firstTweet = document.querySelector('article[data-testid="tweet"]');
    if (!firstTweet) return { text: '', author: '' };
    const textEl = firstTweet.querySelector('[data-testid="tweetText"]');
    const userEl = firstTweet.querySelector('[data-testid="User-Name"]');
    return {
      text: (textEl?.innerText || '').replace(/\s+/g, ' ').trim(),
      author: (userEl?.innerText || '').replace(/\s+/g, ' ').trim(),
    };
  }).catch(() => ({ text: '', author: '' }));

  const title = mainTweet.author ? `${mainTweet.author}: ${mainTweet.text.slice(0, 100)}` : 'Twitter Post';
  const body = `Author: ${mainTweet.author}\nTweet content:\n${mainTweet.text}`;

  return {
    title,
    body,
    tweetText: mainTweet.text,
    author: mainTweet.author,
    isTwitter: true,
  };
}

async function submitAnswer(page, reply) {
  // 1. Locate the reply trigger or inline editor
  let editor = page.locator('div[data-testid="tweetTextarea_0"][contenteditable="true"]').first();
  let isEditorReady = await editor.isVisible().catch(() => false);

  if (!isEditorReady) {
    // Check for inline reply container click target
    const inlinePlaceholder = page.locator('div[data-testid="tweetTextarea_0_label"], [data-testid="inline_reply"]').first();
    if (await inlinePlaceholder.isVisible().catch(() => false)) {
      await inlinePlaceholder.click().catch(() => {});
      await page.waitForTimeout(500);
    } else {
      // Click the Reply button on the main tweet to open the reply dialog modal
      const replyBtn = page.locator('article[data-testid="tweet"] button[data-testid="reply"], button[data-testid="reply"]').first();
      if (await replyBtn.isVisible().catch(() => false)) {
        await replyBtn.click().catch(() => {});
        await page.waitForTimeout(800);
      }
    }
  }

  // 2. Poll for active reply editor
  const editorSelectors = [
    'div[data-testid="tweetTextarea_0"][contenteditable="true"]',
    'div[data-testid="tweetTextarea_0"]',
    'div[role="dialog"] div[role="textbox"]',
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
    await page.waitForTimeout(400);
  }

  if (!activeEditor) {
    activeEditor = page.locator('div[role="textbox"]').first();
    await activeEditor.waitFor({ state: 'visible', timeout: 10000 });
  }

  // 3. Focus and insert reply
  await activeEditor.scrollIntoViewIfNeeded().catch(() => {});
  await activeEditor.click();
  await page.waitForTimeout(300);

  await page.keyboard.insertText(reply);
  await page.waitForTimeout(500);

  const currentContent = (await activeEditor.innerText().catch(() => '')).trim();
  if (!currentContent) {
    await activeEditor.fill(reply).catch(() => {});
  }
  await page.waitForTimeout(1000);

  // 4. Click the Tweet / Reply button
  const submitSelectors = [
    'button[data-testid="tweetButtonInline"]',
    'button[data-testid="tweetButton"]',
    'button:has-text("Reply")',
    'button:has-text("Post")',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    const sBtn = page.locator(sel).first();
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
    await page.getByRole('button', { name: /^(Reply|Post)$/i }).first().click().catch(() => {});
  }

  await page.waitForTimeout(4000);
}

async function answerVisible(page, answer) {
  const cleanAnswer = answer.replace(/[*#_`]/g, '').replace(/\s+/g, ' ').trim();
  const sample = cleanAnswer.slice(0, 25);
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
  const sample = cleanAnswer.slice(0, 20);

  const found = await page.evaluate((snippet) => {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    for (const art of articles) {
      if ((art.innerText || '').includes(snippet)) {
        const link = art.querySelector('a[href*="/status/"]');
        if (link?.href) return link.href;
      }
    }
    return null;
  }, sample).catch(() => null);

  return found || page.url();
}

module.exports = {
  id: 'twitter',
  name: 'Twitter (X)',
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
