const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const config = require('../config');
const { Session } = require('../models');

let remoteBrowser = null;
let context = null;
let page = null;
let activeSessionId = null;
let mode = null; // 'login' | 'run' | null

/**
 * Detect remote browser URL (Method 1: Browserless / Chrome CDP).
 * Supports:
 * - SERVER_BROWSER (e.g. "http://1.2.3.4:3000" or "ws://1.2.3.4:3000")
 * - server_browser (case-insensitive)
 * - BROWSER_SERVER_URL
 */
function getRemoteServerUrl() {
  const envVal = (
    process.env.SERVER_BROWSER ||
    process.env.server_browser ||
    process.env.BROWSER_SERVER_URL ||
    config.serverBrowser ||
    ''
  ).trim();

  if (!envVal || envVal.toLowerCase() === 'false') {
    return null;
  }

  // If user sets "true" or "1", default to localhost:3000 (standard Browserless port)
  if (envVal.toLowerCase() === 'true' || envVal === '1') {
    return 'http://localhost:3000';
  }

  return envVal;
}

/**
 * Detect whether the application is running inside a VPS / Docker container
 * when running local Chromium (without remote SERVER_BROWSER).
 */
function isServerEnvironment() {
  if (process.env.BROWSER_SERVER === 'true') {
    return true;
  }
  try {
    require('fs').accessSync('/.dockerenv');
    return true;
  } catch (_) {
    return false;
  }
}

function getDisplay() {
  return process.env.DISPLAY || ':99';
}

function statusFile(sessionId) {
  return path.join(config.sessionDir, sessionId, 'status.json');
}

function cookiesFilePath(sessionId) {
  return path.join(config.sessionDir, sessionId, 'cookies.json');
}

function httpError(message, statusCode, code) {
  const error = new Error(message);
  error.status = statusCode;
  if (code) error.code = code;
  return error;
}

/**
 * Load saved cookies for a session to maintain persistent authentication
 * across remote containers and server restarts.
 */
async function loadCookies(targetContext, sessionId) {
  if (!targetContext || !sessionId) return;
  try {
    const file = cookiesFilePath(sessionId);
    const content = await fs.readFile(file, 'utf8');
    const cookies = JSON.parse(content);
    if (Array.isArray(cookies) && cookies.length > 0) {
      // Filter out invalid/expired properties that might cause addCookies to fail
      const sanitized = cookies.map((c) => {
        const copy = { ...c };
        // Delete sameSite if invalid
        if (copy.sameSite && !['Strict', 'Lax', 'None'].includes(copy.sameSite)) {
          delete copy.sameSite;
        }
        return copy;
      });
      await targetContext.addCookies(sanitized);
      console.log(`[cookies] Restored ${sanitized.length} cookies for session "${sessionId}"`);
    }
  } catch {
    // No cookies saved yet or file not found
  }
}

/**
 * Save cookies from current context to sessions/<sessionId>/cookies.json
 */
async function saveCookies(targetContext, sessionId) {
  if (!targetContext || !sessionId) return;
  try {
    const cookies = await targetContext.cookies();
    if (Array.isArray(cookies) && cookies.length > 0) {
      const file = cookiesFilePath(sessionId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(cookies, null, 2), 'utf8');
      console.log(`[cookies] Saved ${cookies.length} cookies for session "${sessionId}"`);
    }
  } catch (err) {
    console.warn(`[cookies] Failed saving cookies for session "${sessionId}":`, err?.message || err);
  }
}

async function close() {
  if (context && activeSessionId) {
    await saveCookies(context, activeSessionId).catch(() => {});
  }

  if (context) {
    try {
      const pages = context.pages();
      for (const p of pages) await p.close().catch(() => {});
      await context.close().catch(() => {});
    } catch {}
    context = null;
    page = null;
  }

  if (remoteBrowser) {
    try {
      await remoteBrowser.close().catch(() => {});
    } catch {}
    remoteBrowser = null;
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
  if ((context || remoteBrowser) && activeSessionId !== sessionId) {
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

function getMode() {
  return mode;
}

function getActiveSessionId() {
  return activeSessionId;
}

/**
 * Launch or connect to browser context.
 * If SERVER_BROWSER is defined, connects via CDP / WebSocket (Method 1).
 * Otherwise, launches a persistent local Chrome/Chromium instance.
 */
async function launch(sessionId, isHeadless = false) {
  // Auto stop old running Chrome instance if present
  await close();

  activeSessionId = sessionId;
  const remoteUrl = getRemoteServerUrl();

  // ==========================================================
  // METHOD 1: REMOTE BROWSER (Browserless / Remote Chrome CDP)
  // ==========================================================
  if (remoteUrl) {
    console.log('======================================');
    console.log('Connecting to REMOTE Browser (Method 1: CDP / Browserless)');
    console.log('Server Browser URL:', remoteUrl);
    console.log('Session ID:', sessionId);
    console.log('Headless:', isHeadless);
    console.log('======================================');

    try {
      // Connect to remote CDP endpoint or Playwright server
      if (remoteUrl.includes('/ws') && !remoteUrl.includes('browserless')) {
        remoteBrowser = await chromium.connect(remoteUrl);
      } else {
        remoteBrowser = await chromium.connectOverCDP(remoteUrl);
      }

      context = await remoteBrowser.newContext({
        viewport: isHeadless ? { width: 1280, height: 800 } : { width: 1366, height: 768 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'en-US',
      });

      // Restore session cookies if available
      await loadCookies(context, sessionId);
    } catch (err) {
      console.error(`Failed to connect to remote browser at "${remoteUrl}":`, err?.message || err);
      remoteBrowser = null;
      context = null;
      throw new Error(`Remote browser connection error (${remoteUrl}): ${err?.message}`);
    }
  } else {
    // ==========================================================
    // LOCAL / PERSISTENT BROWSER LAUNCH
    // ==========================================================
    const server = isServerEnvironment();
    const dir = path.join(config.sessionDir, sessionId, 'browser-profile');
    await fs.mkdir(dir, { recursive: true });

    console.log('======================================');
    console.log('Launching LOCAL browser');
    console.log('Environment:', server ? 'SERVER (VPS/Docker)' : 'LOCAL');
    console.log('Session:', sessionId);
    console.log('Headless:', isHeadless);
    console.log('Profile Dir:', dir);

    if (server) {
      const display = getDisplay();
      process.env.DISPLAY = display;
      console.log('DISPLAY:', display);
    }

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
        ...(server ? ['--disable-gpu', '--disable-software-rasterizer'] : []),
      ],
    };

    try {
      console.log('Trying Google Chrome...');
      context = await chromium.launchPersistentContext(dir, {
        ...launchOptions,
        channel: 'chrome',
      });
      console.log('Google Chrome launched successfully.');
    } catch (chromeError) {
      console.warn('Google Chrome launch failed, falling back to Chromium:', chromeError?.message || chromeError);
      context = await chromium.launchPersistentContext(dir, launchOptions);
      console.log('Playwright Chromium launched successfully.');
    }

    // Try restoring JSON cookies if profile database is empty/fresh
    await loadCookies(context, sessionId);
  }

  // Anti-bot detection masking on context
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(30000);
  return context;
}

async function beginLogin(platform, sessionId = 'quora') {
  // Auto-stop old running Chrome instance if present
  await close();

  mode = 'login';
  activeSessionId = sessionId;

  const remoteUrl = getRemoteServerUrl();
  if (remoteUrl) {
    const liveViewerUrl = remoteUrl
      .replace(/^ws:\/\//i, 'http://')
      .replace(/^wss:\/\//i, 'https://')
      .replace(/\/$/, '') + '/debugger';
    console.log('----------------------------------------------------');
    console.log(`[LOGIN] Browser connected on remote server!`);
    console.log(`[LOGIN] Live interactive view: ${liveViewerUrl}`);
    console.log('----------------------------------------------------');
  }

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
    if (ok && context) {
      // Persist authenticated cookies immediately
      await saveCookies(context, sessionId);
    }
  } finally {
    // Auto-close browser after confirm
    await close();
    release();
  }

  const nextStatus = ok ? 'READY' : 'ERROR';
  await setStatus(sessionId, nextStatus);
  if (!ok) {
    throw httpError(`${platform.name || 'Platform'} login was not detected. Please make sure you are logged in.`, 400);
  }
  return nextStatus;
}

async function runWith(platform, sessionId, work) {
  try {
    // Respect BROWSER_HEADLESS env configuration for task runs
    await launch(sessionId, config.headless);
    const result = await work(page);
    if (context) {
      await saveCookies(context, sessionId).catch(() => {});
    }
    return result;
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
  getRemoteServerUrl,
  getMode,
  getActiveSessionId,
};
