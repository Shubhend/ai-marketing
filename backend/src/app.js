const express = require('express');
const config = require('./config');
const routes = require('./routes');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', routes);
app.use((error, req, res, next) => {
  res.status(error.status || 500).json({
    error: config.safeMessage(error),
    code: error.code,
  });
});

module.exports = { app };
