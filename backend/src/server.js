const dns = require('dns');
const mongoose = require('mongoose');
const config = require('./config');

dns.setServers(['8.8.8.8', '1.1.1.1']);
const { app } = require('./app');
const browser = require('./core/browser');
const scheduler = require('./core/scheduler');
const { Execution } = require('./models');

async function main() {
  await mongoose.connect(config.mongoUri);
  await Execution.updateMany(
    { status: 'RUNNING' },
    { $set: { status: 'FAILED', failure: { stage: 'session', pageUrl: '', reason: 'Server restarted during this run', at: new Date() } } },
  );
  await browser.init();
  await scheduler.init();
  app.listen(config.port, () => {
    console.log(`API listening on ${config.port}`);
  });
}

main().catch((error) => {
  console.error(config.safeMessage(error));
  process.exit(1);
});
