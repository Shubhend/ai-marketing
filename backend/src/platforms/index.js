const quora = require('./quora');
const quoraComment = require('./quora-comment');
const quoraEnd = require('./quora-end');
const twitter = require('./twitter');

const all = [quora, quoraComment, quoraEnd, twitter];

function get(id = 'quora') {
  const targetId = id === 'x' ? 'twitter' : id;
  const platform = all.find((item) => item.id === targetId);
  if (!platform) {
    const error = new Error(`Unknown platform: ${id}`);
    error.status = 400;
    throw error;
  }
  return platform;
}

module.exports = { all, get };
