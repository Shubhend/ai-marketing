const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const config = require('../config');
const { Session } = require('../models');

let context = null;
let page = null;
let activeSessionId = null;
let mode = null; // 'login' | 'run' | null

function statusFile(sessionId) {
  return path.join(config.sessionDir, sessionId, 'status.json');
}

function httpError(message, statusCode, code) {
  const error = new Error(message);
  error.status = statusCode;
  if (code) error.code = code;
  return error;
}

async function close() {
  if (context) {
    try {
      const pages = context.pages();
      for (const p of pages) await p.close().catch(() => {});
      await context.close().catch(() => {});
    } catch {}
    context = null;
    page = null;
  }
  activeSessionId = null;
  mode = null;
}

async function getStoredStatus(sessionId) {
  try {
    const saved = JSON.parse(await fs.readFile(statusFile(sessionId), 'utf8'));
    return saved.status || 'CREATING';
  } catch {
    const doc = await Session.findOne({ sessionId });
    return doc?.status || 'CREATING';
  }
}

async function setStatus(sessionId, nextStatus) {
  const file = statusFile(sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ status: nextStatus, updatedAt: new Date().toISOString() }));
  await Session.findOneAndUpdate(
    { sessionId },
    { status: nextStatus },
    { upsert: true },
  );
}

function liveStatus(sessionId) {
  if (mode && activeSessionId === sessionId) return 'RUNNING';
  return null;
}

async function snapshot(sessionId = 'quora') {
  const live = liveStatus(sessionId);
  if (live) return { sessionId, status: live };
  const status = await getStoredStatus(sessionId);
  return { sessionId, status };
}

async function init() {
  // Sync all sessions to ensure no stale RUNNING states
  await Session.updateMany({ status: 'RUNNING' }, { $set: { status: 'READY' } });
}

async function reserve(sessionId) {
  // Auto-stop old running browser if it was abandoned in a previous run/login
  if (context && activeSessionId !== sessionId) {
    await close();
  }
  if (mode && activeSessionId === sessionId) {
    throw httpError(`Session "${sessionId}" is already in use`, 409, 'SESSION_BUSY');
  }
  const session = await Session.findOne({ sessionId });
  if (!session || session.status !== 'READY') {
    throw httpError(`Session "${sessionId}" is not READY. Please log in first.`, 409, 'NOT_READY');
  }
  mode = 'run';
  activeSessionId = sessionId;
}

function release() {
  mode = null;
  activeSessionId = null;
}

async function launch(sessionId, isHeadless = false) {
  // Auto stop old running Chrome instance if present
  await close();

  activeSessionId = sessionId;
  const dir = path.join(config.sessionDir, sessionId, 'browser-profile');
  await fs.mkdir(dir, { recursive: true });

  const launchOptions = {
    headless: isHeadless,
    viewport: isHeadless ? { width: 1280, height: 800 } : null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      isHeadless ? '--window-size=1280,800' : '--start-maximized',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--lang=en-US,en',
    ],
  };

  try {
    // Prefer installed Google Chrome if available
    context = await chromium.launchPersistentContext(dir, {
      ...launchOptions,
      channel: 'chrome',
    });
  } catch {
    // Fall back to bundled Chromium
    context = await chromium.launchPersistentContext(dir, launchOptions);
  }

  // Anti-bot detection masking
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);
}

async function beginLogin(platform, sessionId = 'quora') {
  // Auto-stop old running Chrome instance if present
  await close();

  mode = 'login';
  activeSessionId = sessionId;
  try {
    // Always visible (headless: false) for manual user login
    await launch(sessionId, false);
    await page.goto(platform.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await setStatus(sessionId, 'RUNNING');
  } catch (error) {
    await close();
    release();
    throw error;
  }
}

async function confirmLogin(platform, sessionId = 'quora') {
  if (!page || activeSessionId !== sessionId) {
    // Open a quick browser instance to verify the saved profile session
    await launch(sessionId, false);
    await page.goto(platform.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  let ok = false;
  try {
    ok = await platform.isLoggedIn(page);
  } finally {
    // Auto-close browser after confirm
    await close();
    release();
  }

  const nextStatus = ok ? 'READY' : 'ERROR';
  await setStatus(sessionId, nextStatus);
  if (!ok) throw httpError(`${platform.name || 'Platform'} login was not detected. Please make sure you are logged in.`, 400);
  return nextStatus;
}

async function runWith(platform, sessionId, work) {
  try {
    // Respect BROWSER_HEADLESS env configuration for task runs
    await launch(sessionId, config.headless);
    return await work(page);
  } finally {
    // Auto-close browser after task completes
    await close();
    release();
  }
}

module.exports = {
  init,
  snapshot,
  reserve,
  release,
  close,
  beginLogin,
  confirmLogin,
  runWith,
  setStatus,
};
