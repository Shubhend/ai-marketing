const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const platforms = require('./platforms');
const catalog = require('./tasks');
const browser = require('./core/browser');
const executor = require('./core/executor');
const scheduler = require('./core/scheduler');
const { Execution, PublishedContent, Session, Task } = require('./models');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function present(doc) {
  if (!doc) return null;
  const row = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete row.__v;
  return row;
}

function hoursOf(value) {
  if (value == null || value === '') return null;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    const error = new Error('everyHours must be a positive number of hours');
    error.status = 400;
    throw error;
  }
  return hours;
}

async function findSession(id) {
  if (!id) return null;
  let doc = await Session.findOne({ sessionId: id });
  if (!doc && /^[0-9a-fA-F]{24}$/.test(String(id))) {
    doc = await Session.findById(id);
  }
  return doc;
}

router.get('/platforms', (req, res) => {
  res.json(platforms.all.map((item) => ({ id: item.id, name: item.name })));
});

router.get('/tasks/available', (req, res) => {
  res.json(catalog.all);
});

// Sessions API
router.get('/sessions', wrap(async (req, res) => {
  const rows = await Session.find().sort({ createdAt: 1 });
  const list = [];
  for (const row of rows) {
    const snap = await browser.snapshot(row.sessionId);
    list.push(present({ ...row.toObject(), status: snap.status }));
  }
  if (!list.length) {
    const def = await Session.findOneAndUpdate(
      { sessionId: 'quora' },
      { sessionId: 'quora', name: 'Quora Main', platform: 'quora', status: 'CREATING' },
      { upsert: true, new: true },
    );
    list.push(present(def));
  }
  res.json(list);
}));

router.post('/sessions', wrap(async (req, res) => {
  const { name, sessionId, platform } = req.body || {};
  if (!name && !sessionId) {
    const error = new Error('Session name or sessionId is required');
    error.status = 400;
    throw error;
  }
  const cleanId = (sessionId || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  const targetPlatform = platform || 'quora';
  platforms.get(targetPlatform);

  const doc = await Session.findOneAndUpdate(
    { sessionId: cleanId },
    {
      $setOnInsert: { sessionId: cleanId, status: 'CREATING' },
      $set: { name: name || cleanId, platform: targetPlatform },
    },
    { new: true, upsert: true },
  );

  res.status(201).json(present(doc));
}));

router.get('/sessions/:id', wrap(async (req, res) => {
  const doc = await findSession(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Session not found' });
  const snap = await browser.snapshot(doc.sessionId);
  res.json(present({ ...doc.toObject(), status: snap.status }));
}));

router.post('/sessions/:id/login', wrap(async (req, res) => {
  let doc = await findSession(req.params.id);
  if (!doc) {
    const cleanId = String(req.params.id).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    doc = await Session.create({
      sessionId: cleanId,
      name: req.body?.name || cleanId,
      platform: req.body?.platform || 'quora',
      status: 'CREATING',
    });
  }
  const platform = platforms.get(doc.platform || 'quora');
  await browser.beginLogin(platform, doc.sessionId);
  res.json({
    _id: doc._id,
    sessionId: doc.sessionId,
    name: doc.name,
    platform: doc.platform,
    status: 'RUNNING',
    message: 'Browser opened. Log in to Quora, then call confirm.',
  });
}));

router.post('/sessions/:id/confirm', wrap(async (req, res) => {
  const doc = await findSession(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Session not found' });
  const platform = platforms.get(doc.platform || 'quora');
  const status = await browser.confirmLogin(platform, doc.sessionId);
  res.json({
    _id: doc._id,
    sessionId: doc.sessionId,
    name: doc.name,
    platform: doc.platform,
    status,
  });
}));

router.post('/sessions/:id/close', wrap(async (req, res) => {
  await browser.close();
  res.json({ sessionId: req.params.id, message: 'Browser stopped and closed.' });
}));

router.delete('/sessions/:id', wrap(async (req, res) => {
  const doc = await findSession(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Session not found' });
  await browser.close().catch(() => {});
  await Session.deleteOne({ _id: doc._id });
  res.json({ sessionId: doc.sessionId, deleted: true });
}));

// Backward compatibility session routes
router.get('/session', wrap(async (req, res) => {
  const snap = await browser.snapshot('quora');
  res.json(snap);
}));

router.post('/session/login', wrap(async (req, res) => {
  const targetId = req.body?.sessionId || 'quora';
  let doc = await findSession(targetId);
  if (!doc) {
    doc = await Session.create({
      sessionId: targetId,
      name: req.body?.name || 'Quora Account',
      platform: 'quora',
      status: 'CREATING',
    });
  }
  const platform = platforms.get('quora');
  await browser.beginLogin(platform, doc.sessionId);
  res.json({ ...present(doc), status: 'RUNNING', message: 'Browser opened. Log in to Quora, then call confirm.' });
}));

router.post('/session/confirm', wrap(async (req, res) => {
  const targetId = req.body?.sessionId || 'quora';
  let doc = await findSession(targetId);
  if (!doc) return res.status(404).json({ error: 'Session not found' });
  const platform = platforms.get(doc.platform || 'quora');
  const status = await browser.confirmLogin(platform, doc.sessionId);
  res.json({ ...present(doc), status });
}));

// Tasks API
router.get('/tasks', wrap(async (req, res) => {
  const rows = await Task.find().sort({ createdAt: -1 }).limit(50);
  const taskIds = rows.map((r) => r.id);
  const latestExecs = await Execution.aggregate([
    { $match: { taskId: { $in: taskIds } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$taskId',
        status: { $first: '$status' },
        executionId: { $first: '$executionId' },
        createdAt: { $first: '$createdAt' },
        failure: { $first: '$failure' },
        proof: { $first: '$proof' },
        answer: { $first: '$answer' },
      },
    },
  ]);
  const execMap = new Map(latestExecs.map((e) => [e._id, e]));
  const result = rows.map((r) => {
    const obj = present(r);
    const exec = execMap.get(r.id);
    obj.lastStatus = exec?.status || (r.lastRunAt ? 'UNKNOWN' : 'NEVER_RUN');
    obj.lastExecutionId = exec?.executionId || null;
    obj.lastFailure = exec?.failure || null;
    obj.lastProof = exec?.proof || null;
    return obj;
  });
  res.json(result);
}));

router.post('/tasks', wrap(async (req, res) => {
  const { name, sessionId, task, prompt, everyHours, runNow } = req.body || {};
  if (!prompt) {
    const error = new Error('prompt is required');
    error.status = 400;
    throw error;
  }
  if (!sessionId) {
    const error = new Error('sessionId is required (pass session name, sessionId, or _id)');
    error.status = 400;
    throw error;
  }
  if (!runNow && !everyHours) {
    const error = new Error('Set runNow or everyHours');
    error.status = 400;
    throw error;
  }
  const hours = hoursOf(everyHours);
  const { session, systemTask } = await executor.resolve(sessionId, task);

  const saved = await Task.create({
    id: crypto.randomUUID(),
    name: name || prompt.slice(0, 50),
    sessionId: session.sessionId,
    task: systemTask.id,
    prompt,
    everyHours: hours,
    enabled: Boolean(hours),
    nextRunAt: hours ? new Date(Date.now() + hours * 60 * 60 * 1000) : null,
  });

  if (hours) scheduler.watch(saved);
  if (!runNow) return res.status(201).json(present(saved));

  try {
    const execution = await executor.start(saved);
    res.status(202).json({ ...present(saved), executionId: execution.executionId });
  } catch (error) {
    res.status(error.status || 500).json({
      ...present(saved),
      error: config.safeMessage(error),
      code: error.code,
    });
  }
}));

router.get('/tasks/:id', wrap(async (req, res) => {
  const row = await Task.findOne({ id: req.params.id });
  if (!row) return res.status(404).json({ error: 'Task not found' });
  res.json(present(row));
}));

router.post('/tasks/:id/run', wrap(async (req, res) => {
  const row = await Task.findOne({ id: req.params.id });
  if (!row) return res.status(404).json({ error: 'Task not found' });
  const execution = await executor.start(row);
  res.status(202).json({ executionId: execution.executionId });
}));

router.put('/tasks/:id', wrap(async (req, res) => {
  const row = await Task.findOne({ id: req.params.id });
  if (!row) return res.status(404).json({ error: 'Task not found' });

  const { name, sessionId, task, prompt, everyHours, enabled } = req.body || {};
  if (name !== undefined) row.name = name;
  if (prompt !== undefined) row.prompt = prompt;

  if (sessionId !== undefined || task !== undefined) {
    const targetSessionId = sessionId !== undefined ? sessionId : row.sessionId;
    const targetTask = task !== undefined ? task : row.task;
    const { session, systemTask } = await executor.resolve(targetSessionId, targetTask);
    row.sessionId = session.sessionId;
    row.task = systemTask.id;
  }

  if (everyHours !== undefined) {
    const hours = hoursOf(everyHours);
    row.everyHours = hours;
    row.enabled = hours ? (enabled !== undefined ? Boolean(enabled) : true) : false;
    row.nextRunAt = hours && row.enabled ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
  } else if (enabled !== undefined) {
    row.enabled = Boolean(enabled) && Boolean(row.everyHours);
  }

  await row.save();
  scheduler.watch(row);
  res.json(present(row));
}));

router.delete('/tasks/:id', wrap(async (req, res) => {
  const row = await Task.findOneAndDelete({ id: req.params.id });
  if (!row) return res.status(404).json({ error: 'Task not found' });
  scheduler.stop(row.id);
  res.json({ id: row.id, deleted: true });
}));

// Executions API
router.get('/executions', wrap(async (req, res) => {
  const query = {};
  if (req.query.status) query.status = String(req.query.status).toUpperCase();
  if (req.query.taskId) query.taskId = String(req.query.taskId);
  if (req.query.sessionId) query.sessionId = String(req.query.sessionId);
  const rows = await Execution.find(query).sort({ createdAt: -1 }).limit(50);
  res.json(rows.map(present));
}));

router.get('/executions/:id', wrap(async (req, res) => {
  const row = await Execution.findOne({ executionId: req.params.id });
  if (!row) return res.status(404).json({ error: 'Execution not found' });
  res.json(present(row));
}));

router.get('/publications', wrap(async (req, res) => {
  const rows = await PublishedContent.find().sort({ publishedAt: -1 }).limit(50);
  res.json(rows.map(present));
}));

module.exports = router;
