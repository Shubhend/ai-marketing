const quora = require('./quora');
const quoraComment = require('./quora-comment');
const quoraEnd = require('./quora-end');
const twitter = require('./twitter');
const facebook = require('./facebook');

const all = [quora, quoraComment, quoraEnd, twitter, facebook];

function get(id = 'quora') {
  let targetId = id;
  if (id === 'x') targetId = 'twitter';
  if (id === 'fb') targetId = 'facebook';
  const platform = all.find((item) => item.id === targetId);
  if (!platform) {
    const error = new Error(`Unknown platform: ${id}`);
    error.status = 400;
    throw error;
  }
  return platform;
}

module.exports = { all, get };
