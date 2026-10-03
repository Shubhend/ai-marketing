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

async function submitAnswer(page, comment) {
  // 1. Locate comment trigger or active comment box
  let editor = page.locator('div[role="textbox"][contenteditable="true"]').first();
  let isEditorReady = await editor.isVisible().catch(() => false);

  if (!isEditorReady) {
    // Look for Comment button/trigger to reveal comment box
    const commentTriggers = [
      'div[role="button"][aria-label*="Comment" i]',
      'div[role="button"]:has-text("Comment")',
      'span:has-text("Comment")',
      'div[aria-label*="Write a comment" i]',
      'div[aria-label*="Write a public comment" i]',
    ];

    for (const sel of commentTriggers) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(300);
        await btn.click().catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(1000);
  }

  // 2. Poll for active comment input
  const editorSelectors = [
    'div[role="textbox"][contenteditable="true"]',
    'div[aria-label*="Write a comment" i][contenteditable="true"]',
    'div[aria-label*="Write a public comment" i][contenteditable="true"]',
    'div[aria-label*="Comment as" i][contenteditable="true"]',
    'div[contenteditable="true"]',
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

  // 3. Focus and type comment
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

  // 4. Submit comment: on Facebook press Enter, or click the send button
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // Fallback: If submit icon button is present, click it
  const sendSelectors = [
    'div[aria-label="Comment"][role="button"]',
    'div[aria-label="Press Enter to post."]',
    'div[aria-label="Send"]',
  ];
  for (const sSel of sendSelectors) {
    const sBtn = page.locator(sSel).first();
    if (await sBtn.isVisible().catch(() => false)) {
      await sBtn.click().catch(() => {});
      break;
    }
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
