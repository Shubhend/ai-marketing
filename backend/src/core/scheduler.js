const config = require('../config');
const { Task } = require('../models');
const executor = require('./executor');

const timers = new Map();

function stop(id) {
  const timer = timers.get(id);
  if (timer) clearInterval(timer);
  timers.delete(id);
}

async function fire(id) {
  const task = await Task.findOne({ id, enabled: true });
  if (!task) return stop(id);
  try {
    await executor.start(task);
  } catch (error) {
    await executor.noteFailure(task, error);
  }
}

function watch(task) {
  stop(task.id);
  if (!task.enabled || !task.everyHours) return;
  const timer = setInterval(() => {
    fire(task.id).catch((error) => console.error(config.safeMessage(error)));
  }, task.everyHours * 60 * 60 * 1000);
  timers.set(task.id, timer);
}

async function init() {
  const tasks = await Task.find({ enabled: true, everyHours: { $gt: 0 } });
  tasks.forEach(watch);
}

module.exports = { init, watch, stop };
