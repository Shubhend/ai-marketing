const all = [
  {
    id: 'quora-marketing',
    name: 'Quora Marketing',
    platform: 'quora',
    description: 'Search recent Quora questions, choose the best one, and post one useful answer.',
  },
  {
    id: 'quora-comment',
    name: 'Quora Comment on Top Post',
    platform: 'quora-comment',
    description: 'Search recent Quora questions, select the top discussion, and post an insightful comment on the top post.',
  },
  {
    id: 'quora-end',
    name: 'Quora Answer at End',
    platform: 'quora-end',
    description: 'Search recent Quora questions, select the top discussion, and post an answer or reply at the end of the thread.',
  },
  {
    id: 'twitter-marketing',
    name: 'Twitter (X) Marketing Reply',
    platform: 'twitter',
    description: 'Search related Twitter/X posts, rank by relevance and engagement, and post an authentic reply/comment.',
  },
  {
    id: 'twitter-comment',
    name: 'Twitter (X) Post Comment',
    platform: 'twitter',
    description: 'Search related Twitter/X posts, select the best discussion, and post an engaging comment on that tweet.',
  },
  {
    id: 'facebook-comment',
    name: 'Facebook Post Comment',
    platform: 'facebook',
    description: 'Search related Facebook posts, select the best discussion, and post an engaging comment on that post.',
  },
  {
    id: 'facebook-marketing',
    name: 'Facebook Marketing Comment',
    platform: 'facebook',
    description: 'Search relevant Facebook public discussions, rank by engagement, and post a helpful, value-adding comment.',
  },
];

function get(id) {
  const targetId = id || 'quora-marketing';
  const task = all.find((item) => item.id === targetId);
  if (!task) {
    const error = new Error(`Task not found: ${id}`);
    error.status = 404;
    throw error;
  }
  return task;
}

module.exports = { all, get };
