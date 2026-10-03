const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const { Execution, PublishedContent, Session } = require('../models');
const platforms = require('../platforms');
const catalog = require('../tasks');
const browser = require('./browser');
const ai = require('./ai');

function emptyUsage() {
  return { callCount: 0, promptTokens: 0, completionTokens: 0, calls: [] };
}

function copyUsage(usage) {
  return {
    callCount: usage.callCount,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    calls: usage.calls.map((call) => ({ ...call })),
  };
}

function urlOf(page) {
  try { return page?.url?.() || ''; } catch { return ''; }
}

function hash(text) {
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

async function step(execution, page, stage, usage, work) {
  const startedAt = new Date();
  execution.steps.push({ stage, status: 'RUNNING', message: '', pageUrl: urlOf(page), startedAt });
  execution.ai = copyUsage(usage);
  execution.markModified('ai');
  await execution.save();
  const current = execution.steps[execution.steps.length - 1];
  try {
    const result = await work();
    current.status = 'OK';
    current.message = result?.message || 'ok';
    current.pageUrl = urlOf(page);
    current.finishedAt = new Date();
    current.durationMs = current.finishedAt - startedAt;
    execution.ai = copyUsage(usage);
    execution.markModified('ai');
    await execution.save();
    return result;
  } catch (error) {
    const reason = config.safeMessage(error);
    current.status = 'FAILED';
    current.message = reason;
    current.pageUrl = urlOf(page);
    current.finishedAt = new Date();
    current.durationMs = current.finishedAt - startedAt;
    execution.status = 'FAILED';
    execution.ai = copyUsage(usage);
    execution.markModified('ai');
    execution.failure = { stage, pageUrl: current.pageUrl, reason, at: new Date() };
    error.stage = stage;
    error.pageUrl = current.pageUrl;
    await execution.save();
    throw error;
  }
}

async function firstEligible(ranked) {
  const since = new Date(Date.now() - config.duplicateCooldownDays * 86400000);
  for (const item of ranked) {
    const existing = await PublishedContent.findOne({ targetUrl: item.url, publishedAt: { $gte: since } });
    if (!existing) return item;
  }
  return null;
}

async function assertCanPublish(answer) {
  const existing = await PublishedContent.findOne({ answerHash: hash(answer) });
  if (existing) throw new Error('This answer was already published');
}

async function saveShot(page, executionId) {
  await fs.mkdir(config.proofDir, { recursive: true });
  const file = path.join(config.proofDir, `${executionId}.png`);
  await page.screenshot({ path: file });
  return path.relative(path.join(__dirname, '../..'), file).replaceAll('\\', '/');
}

async function runFlow({ execution, platform, page, usage }) {
  await step(execution, page, 'session', usage, async () => {
    await page.goto(platform.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!(await platform.isLoggedIn(page))) throw new Error(`${platform.name || 'Platform'} login expired`);
    return { message: 'Session ready' };
  });

  const brief = execution.content || execution.prompt;
  const query = platform.searchText(execution.prompt, brief);
  await step(execution, page, 'search', usage, async () => {
    await platform.openSearch(page, query);
    return { message: `query=${query}` };
  });

  let candidates = [];
  await step(execution, page, 'extract', usage, async () => {
    candidates = await platform.extract(page);
    execution.candidates = candidates;
    if (!candidates.length) throw new Error(`No posts found on ${platform.name || 'platform'}`);
    return { message: `${candidates.length} candidates` };
  });

  let best;
  let question;
  await step(execution, page, 'rank', usage, async () => {
    const picks = await ai.rank(usage, { prompt: execution.prompt, content: brief, candidates });
    best = await firstEligible(platform.rank(candidates, picks).filter((item) => item.score > 0));
    if (!best) throw new Error('No eligible question');
    return { message: best.title };
  });

  await step(execution, page, 'open', usage, async () => {
    question = await platform.openQuestion(page, best.url);
    execution.selected = { url: best.url, title: question.title, score: best.score, reason: best.reason };
    return { message: question.title };
  });

  let draft;
  await step(execution, page, 'generate', usage, async () => {
    draft = await ai.writeAnswer(usage, { prompt: execution.prompt, content: brief, question });
    if (!draft.answer) throw new Error('AI returned an empty answer');
    execution.answer = draft.answer;
    execution.reason = draft.reason || best.reason;
    return { message: 'Answer generated' };
  });

  await step(execution, page, 'validate', usage, async () => {
    await assertCanPublish(draft.answer);
    return { message: 'Ready to post' };
  });

  await step(execution, page, 'submit', usage, async () => {
    await platform.submitAnswer(page, draft.answer);
    return { message: 'Submitted' };
  });

  await step(execution, page, 'verify', usage, async () => {
    if (!(await platform.answerVisible(page, draft.answer))) throw new Error('Submitted answer is not visible');
    const proofUrl = await platform.proofUrl(page, draft.answer);
    const screenshotPath = await saveShot(page, execution.executionId);
    execution.proof = { proofUrl, screenshotPath };
    await PublishedContent.create({
      executionId: execution.executionId,
      targetUrl: best.url,
      targetTitle: question.title,
      content: execution.content,
      finalAnswer: draft.answer,
      decisionReason: execution.reason,
      proofUrl,
      screenshotPath,
      answerHash: hash(draft.answer),
      publishedAt: new Date(),
    });
    return { message: proofUrl };
  });
}

async function execute(execution) {
  const usage = emptyUsage();
  const platform = platforms.get(execution.platform || 'quora');
  const sessionId = execution.sessionId || 'quora';
  try {
    await browser.runWith(platform, sessionId, (page) => runFlow({ execution, platform, page, usage }));
    execution.status = 'COMPLETED';
    execution.ai = copyUsage(usage);
    execution.markModified('ai');
    await execution.save();
  } catch (error) {
    if (execution.status !== 'FAILED') {
      execution.status = 'FAILED';
      execution.ai = copyUsage(usage);
      execution.markModified('ai');
      execution.failure = {
        stage: error.stage || 'session',
        pageUrl: error.pageUrl || '',
        reason: config.safeMessage(error),
        at: new Date(),
      };
      await execution.save();
    }
    if (/login expired/i.test(String(error.message))) await browser.setStatus(sessionId, 'ERROR');
  }
}

async function resolve(sessionId, taskKey) {
  const systemTask = catalog.get(taskKey);
  let session = await Session.findOne({ sessionId });
  if (!session && sessionId && /^[0-9a-fA-F]{24}$/.test(String(sessionId))) {
    session = await Session.findById(sessionId);
  }
  if (!session) {
    const error = new Error(`Session "${sessionId}" not found. Create or log in to a session first.`);
    error.status = 404;
    throw error;
  }
  const isCompatible = session.platform === systemTask.platform ||
    (session.platform?.startsWith('quora') && systemTask.platform?.startsWith('quora')) ||
    (session.platform?.startsWith('twitter') && systemTask.platform?.startsWith('twitter')) ||
    (session.platform === 'x' && systemTask.platform?.startsWith('twitter')) ||
    (session.platform?.startsWith('facebook') && systemTask.platform?.startsWith('facebook')) ||
    (session.platform === 'fb' && systemTask.platform?.startsWith('facebook'));
  if (!isCompatible) {
    const error = new Error(`Task platform "${systemTask.platform}" does not match session platform "${session.platform}"`);
    error.status = 400;
    throw error;
  }
  return { systemTask, session };
}

async function noteFailure(task, error) {
  await Execution.create({
    executionId: crypto.randomUUID(),
    status: 'FAILED',
    taskId: task.id,
    taskName: task.name || '',
    sessionId: task.sessionId,
    systemTask: task.task,
    prompt: task.prompt,
    failure: {
      stage: 'session',
      pageUrl: '',
      reason: config.safeMessage(error),
      at: new Date(),
    },
    ai: emptyUsage(),
  });
}

async function start(task) {
  const { systemTask, session } = await resolve(task.sessionId, task.task);
  await browser.reserve(session.sessionId);
  try {
    task.lastRunAt = new Date();
    if (task.everyHours) task.nextRunAt = new Date(Date.now() + task.everyHours * 60 * 60 * 1000);
    await task.save();
    const execution = await Execution.create({
      executionId: crypto.randomUUID(),
      status: 'RUNNING',
      taskId: task.id,
      taskName: task.name || '',
      sessionId: session.sessionId,
      systemTask: systemTask.id,
      platform: systemTask.platform,
      prompt: task.prompt,
      content: task.prompt,
      ai: emptyUsage(),
    });
    execute(execution).catch((error) => console.error(config.safeMessage(error)));
    return execution;
  } catch (error) {
    browser.release();
    throw error;
  }
}

module.exports = { start, noteFailure, resolve };
