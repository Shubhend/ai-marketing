const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

let context = null;
let page = null;
let activeSessionId = null;
let mode = null; // 'login' | 'run' | null

/**
 * Detect server environment.
 *
 * SERVER:
 *   BROWSER_SERVER=true
 *
 * LOCAL:
 *   BROWSER_SERVER is not set
 */
function isServerEnvironment() {
  return process.env.BROWSER_SERVER === 'true';
}

/**
 * Get X display for server.
 *
 * Default:
 *   :99
 */
function getDisplay() {
  return process.env.DISPLAY || ':99';
}

/**
 * Launch persistent Chromium profile.
 *
 * Local:
 *   launch(sessionId, false)
 *   -> normal visible Chrome
 *
 * Server:
 *   launch(sessionId, false)
 *   -> visible Chrome on Xvfb
 *
 * Automation:
 *   launch(sessionId, true)
 *   -> headless Chrome/Chromium
 */
async function launch(sessionId, isHeadless = false) {
  if (context) {
    return context;
  }

  const server = isServerEnvironment();

  activeSessionId = sessionId;

  const dir = path.join(
    config.sessionDir,
    sessionId,
    'browser-profile'
  );

  await fs.mkdir(dir, {
    recursive: true,
  });

  console.log('======================================');
  console.log('Launching browser');
  console.log(
    'Environment:',
    server ? 'SERVER' : 'LOCAL'
  );
  console.log('Session:', sessionId);
  console.log('Headless:', isHeadless);
  console.log('Profile:', dir);

  /*
   * Only configure DISPLAY on server.
   *
   * Local machine is completely untouched.
   */
  if (server) {
    const display = getDisplay();

    process.env.DISPLAY = display;

    console.log('DISPLAY:', display);
  }

  const launchOptions = {
    headless: isHeadless,

    viewport: isHeadless
      ? {
          width: 1280,
          height: 800,
        }
      : null,

    ignoreDefaultArgs: [
      '--enable-automation',
    ],

    args: [
      '--disable-blink-features=AutomationControlled',

      isHeadless
        ? '--window-size=1280,800'
        : '--start-maximized',

      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--lang=en-US,en',

      /*
       * Server-only Chromium arguments.
       *
       * Local launch arguments remain unchanged.
       */
      ...(server
        ? [
            '--disable-gpu',
            '--disable-software-rasterizer',
          ]
        : []),
    ],
  };

  /*
   * =====================================================
   * Try installed Google Chrome
   * =====================================================
   */
  try {
    console.log('Trying Google Chrome...');

    context =
      await chromium.launchPersistentContext(
        dir,
        {
          ...launchOptions,
          channel: 'chrome',
        }
      );

    console.log(
      'Google Chrome launched successfully.'
    );
  } catch (chromeError) {
    console.warn(
      'Google Chrome launch failed:',
      chromeError?.message || chromeError
    );

    /*
     * ===================================================
     * Fallback to Playwright bundled Chromium
     * ===================================================
     */
    try {
      console.log(
        'Trying Playwright Chromium...'
      );

      context =
        await chromium.launchPersistentContext(
          dir,
          launchOptions
        );

      console.log(
        'Playwright Chromium launched successfully.'
      );
    } catch (chromiumError) {
      console.error(
        'Playwright Chromium launch failed:',
        chromiumError?.message || chromiumError
      );

      context = null;
      activeSessionId = null;

      throw chromiumError;
    }
  }

  /*
   * =====================================================
   * Browser initialization
   * =====================================================
   */

  context.setDefaultTimeout(
    config.browserTimeout || 30000
  );

  await context.addInitScript(() => {
    Object.defineProperty(
      navigator,
      'webdriver',
      {
        get: () => undefined,
      }
    );

    Object.defineProperty(
      navigator,
      'languages',
      {
        get: () => [
          'en-US',
          'en',
        ],
      }
    );

    Object.defineProperty(
      navigator,
      'plugins',
      {
        get: () => [
          1,
          2,
          3,
          4,
          5,
        ],
      }
    );
  });

  /*
   * =====================================================
   * Existing page handling
   * =====================================================
   */

  const pages = context.pages();

  if (pages.length > 0) {
    page = pages[0];
  } else {
    page = await context.newPage();
  }

  console.log(
    'Browser ready. Pages:',
    context.pages().length
  );

  return context;
}