const crypto = require('crypto');
const config = require('../config');
const { Execution } = require('../models');
const browser = require('./browser');

const queueList = [];
let isProcessing = false;
let activeExecution = null;
let jobRunner = null;

function emptyUsage() {
  return { callCount: 0, promptTokens: 0, completionTokens: 0, calls: [] };
}

function registerRunner(fn) {
  jobRunner = fn;
}

function isTaskPending(taskId) {
  if (activeExecution && activeExecution.taskId === taskId) {
    return true;
  }
  return queueList.some((item) => item.taskId === taskId);
}

function getStatus() {
  return {
    isProcessing,
    activeExecution: activeExecution
      ? {
          executionId: activeExecution.executionId,
          taskId: activeExecution.taskId,
          taskName: activeExecution.taskName,
          sessionId: activeExecution.sessionId,
          startedAt: activeExecution.startedAt,
        }
      : null,
    queueLength: queueList.length,
    queue: queueList.map((item, idx) => ({
      position: idx + 1,
      executionId: item.executionId,
      taskId: item.taskId,
      taskName: item.taskName,
      sessionId: item.sessionId,
      enqueuedAt: item.enqueuedAt,
    })),
  };
}

async function enqueue(task, resolver) {
  const { session, systemTask } = resolver
    ? await resolver(task.sessionId, task.task)
    : { session: { sessionId: task.sessionId }, systemTask: { id: task.task, platform: 'quora' } };

  task.lastRunAt = new Date();
  if (task.everyHours) {
    task.nextRunAt = new Date(Date.now() + task.everyHours * 60 * 60 * 1000);
  }
  await task.save().catch(() => {});

  const execution = await Execution.create({
    executionId: crypto.randomUUID(),
    status: 'QUEUED',
    taskId: task.id,
    taskName: task.name || '',
    sessionId: session.sessionId,
    systemTask: systemTask.id,
    platform: systemTask.platform,
    prompt: task.prompt,
    content: task.prompt,
    ai: emptyUsage(),
  });

  queueList.push({
    executionId: execution.executionId,
    taskId: task.id,
    taskName: task.name || '',
    sessionId: session.sessionId,
    enqueuedAt: new Date(),
  });

  console.log(`[queue] Task enqueued: "${task.name || task.id}" (${execution.executionId}). Queue length: ${queueList.length}`);

  triggerWorker();

  return execution;
}

function triggerWorker() {
  if (isProcessing) return;
  processQueue().catch((err) => {
    console.error('[queue:worker] Fatal error in queue processor:', config.safeMessage(err));
    isProcessing = false;
  });
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (queueList.length > 0) {
      // If user is currently performing manual login via UI, pause queue worker
      if (typeof browser.getMode === 'function' && browser.getMode() === 'login') {
        console.log('[queue] User is currently performing manual login. Pausing queue worker for 5s...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      const item = queueList.shift();
      const execution = await Execution.findOne({ executionId: item.executionId });
      if (!execution) {
        continue;
      }
      if (execution.status !== 'QUEUED') {
        continue;
      }

      activeExecution = {
        executionId: execution.executionId,
        taskId: execution.taskId,
        taskName: execution.taskName,
        sessionId: execution.sessionId,
        startedAt: new Date(),
      };

      console.log(`[queue] >>> STARTING JOB: "${execution.taskName || execution.taskId}" (${execution.executionId}) | Session: ${execution.sessionId} | Platform: ${execution.platform}`);

      execution.status = 'RUNNING';
      await execution.save();

      try {
        if (jobRunner) {
          await jobRunner(execution);
        } else {
          throw new Error('No job runner registered in queue');
        }
      } catch (err) {
        console.error(`[queue] Error executing job "${execution.executionId}":`, config.safeMessage(err));
      } finally {
        activeExecution = null;
        console.log(`[queue] <<< FINISHED JOB: "${execution.executionId}". Remaining in queue: ${queueList.length}`);
        // Cooldown between jobs so browser processes exit and profile locks are fully released
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Check if any pending executions in DB were not in memory
    const pendingDb = await Execution.find({ status: 'QUEUED' }).sort({ createdAt: 1 }).limit(10);
    for (const ex of pendingDb) {
      if (!queueList.some((i) => i.executionId === ex.executionId)) {
        queueList.push({
          executionId: ex.executionId,
          taskId: ex.taskId,
          taskName: ex.taskName,
          sessionId: ex.sessionId,
          enqueuedAt: ex.createdAt || new Date(),
        });
      }
    }

    if (queueList.length > 0) {
      isProcessing = false;
      return triggerWorker();
    }
  } finally {
    isProcessing = false;
  }
}

async function init() {
  const pending = await Execution.find({ status: 'QUEUED' }).sort({ createdAt: 1 });
  if (pending.length > 0) {
    console.log(`[queue] Restoring ${pending.length} pending queued job(s) from database...`);
    for (const ex of pending) {
      if (!queueList.some((i) => i.executionId === ex.executionId)) {
        queueList.push({
          executionId: ex.executionId,
          taskId: ex.taskId,
          taskName: ex.taskName,
          sessionId: ex.sessionId,
          enqueuedAt: ex.createdAt || new Date(),
        });
      }
    }
    triggerWorker();
  }
}

module.exports = {
  init,
  enqueue,
  registerRunner,
  getStatus,
  isTaskPending,
};
