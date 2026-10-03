const { Schema, model } = require('mongoose');

const stepSchema = new Schema({
  stage: String,
  status: String,
  message: String,
  pageUrl: String,
  startedAt: Date,
  finishedAt: Date,
  durationMs: Number,
}, { _id: false });

const callSchema = new Schema({
  purpose: String,
  model: String,
  status: Number,
  durationMs: Number,
  promptTokens: Number,
  completionTokens: Number,
}, { _id: false });

const candidateSchema = new Schema({
  title: String,
  url: String,
  snippet: String,
  answers: String,
  upvotes: String,
  views: String,
  followers: String,
  recency: String,
  score: Number,
  reason: String,
}, { _id: false });

const executionSchema = new Schema({
  executionId: { type: String, unique: true, index: true },
  status: { type: String, default: 'QUEUED', index: true },
  taskId: String,
  taskName: String,
  sessionId: String,
  systemTask: String,
  platform: String,
  prompt: String,
  content: Schema.Types.Mixed,
  steps: [stepSchema],
  ai: {
    callCount: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    calls: [callSchema],
  },
  candidates: [candidateSchema],
  selected: {
    url: String,
    title: String,
    score: Number,
    reason: String,
  },
  answer: String,
  reason: String,
  proof: {
    proofUrl: String,
    screenshotPath: String,
  },
  failure: {
    stage: String,
    pageUrl: String,
    reason: String,
    at: Date,
  },
}, { timestamps: true });

const sessionSchema = new Schema({
  sessionId: { type: String, unique: true },
  name: String,
  platform: String,
  status: String,
}, { timestamps: true });

const taskSchema = new Schema({
  id: { type: String, unique: true },
  name: String,
  sessionId: String,
  task: String,
  prompt: String,
  everyHours: Number,
  enabled: { type: Boolean, default: false },
  lastRunAt: Date,
  nextRunAt: Date,
}, { timestamps: true });

const publicationSchema = new Schema({
  executionId: String,
  targetUrl: { type: String, index: true },
  targetTitle: String,
  content: Schema.Types.Mixed,
  finalAnswer: String,
  decisionReason: String,
  proofUrl: String,
  screenshotPath: String,
  answerHash: { type: String, index: true },
  publishedAt: { type: Date, index: true },
}, { timestamps: true });

module.exports = {
  Session: model('Session', sessionSchema),
  Task: model('Task', taskSchema),
  Execution: model('Execution', executionSchema),
  PublishedContent: model('PublishedContent', publicationSchema),
};
