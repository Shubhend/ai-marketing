# Quora Marketing API

Node.js API that manages dynamic persistent browser sessions, logs into Quora through an anti-detection browser profile, searches recent questions, asks Groq to rank candidates and compose a contextual answer, posts it, and captures publication proof.

There is no frontend. Each execution uses at most two Groq calls (rank, then generate) to optimize token usage.

## Requirements

- Node.js 20 or newer
- MongoDB running locally or MongoDB Atlas
- A Groq API key
- A Quora account for manual login

## Setup

```bash
cd backend
npm install
npx playwright install chromium
copy .env.example .env
```

Configure `backend/.env`:
- `GROQ_API_KEY`: your Groq API key
- `MONGODB_URI`: your MongoDB connection string
- `BROWSER_HEADLESS`: set `false` to see browser actions, or `true` to run background automation

Start the backend with auto-reload (nodemon):

```bash
npm start
# or
npm run dev
```

The API listens on `http://localhost:5000`.

## Sessions

### 1. Create a session

```bash
# Quora session
curl -X POST http://localhost:5000/api/sessions \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"My Quora Account\",\"sessionId\":\"my-quora-account\",\"platform\":\"quora\"}"

# Twitter (X) session
curl -X POST http://localhost:5000/api/sessions \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"My Twitter Account\",\"sessionId\":\"my-twitter-account\",\"platform\":\"twitter\"}"
```

Returns `_id`, `sessionId`, `name`, `platform`, and `status: CREATING`.

### 2. Login to platform

```bash
# Open browser to log in manually (Quora or Twitter)
curl -X POST http://localhost:5000/api/sessions/my-twitter-account/login
```

Any old running Chrome instance is automatically stopped. A visible browser window opens with that session's profile. Log in manually in that window. Your credentials are never stored.

### 3. Confirm login

```bash
curl -X POST http://localhost:5000/api/sessions/my-twitter-account/confirm
```

Verifies the login state, automatically closes the browser window, and sets the session status to `READY`.

### 4. Close session browser (optional)

```bash
curl -X POST http://localhost:5000/api/sessions/my-quora-account/close
```

## Tasks

### Available system tasks

```bash
curl http://localhost:5000/api/tasks/available
```

### Create and run a task

Pass `name`, `sessionId` (or the session `_id`), and the system task:
- `quora-marketing`: Posts a standalone Answer to the question.
- `quora-comment`: Posts a Comment directly on the top post/answer.
- `quora-end`: Posts an Answer/Reply at the end of the discussion thread.
- `twitter-marketing` / `twitter-comment`: Searches relevant tweets, ranks them, and posts an engaging reply/comment under 280 characters.

```bash
# 1. Post an Answer to the selected Quora question
curl -X POST http://localhost:5000/api/tasks \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Payment Gateways Campaign\",\"sessionId\":\"my-quora-account\",\"task\":\"quora-marketing\",\"prompt\":\"Find recent Quora questions about payment gateways for startups. Write a useful answer. Mention https://example.com only when it genuinely fits.\",\"runNow\":true}"

# 2. Post a Comment on the top post of the selected Quora discussion
curl -X POST http://localhost:5000/api/tasks \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Fitness Comment Campaign\",\"sessionId\":\"my-quora-account\",\"task\":\"quora-comment\",\"prompt\":\"Find fitness discussions. Write an insightful comment on the top post.\",\"runNow\":true}"

# 3. Post an Answer/Reply at the end of the thread
curl -X POST http://localhost:5000/api/tasks \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Fitness Thread Conclusion Campaign\",\"sessionId\":\"my-quora-account\",\"task\":\"quora-end\",\"prompt\":\"Find fitness discussions. Provide a valuable conclusion and reply at the end of the thread.\",\"runNow\":true}"

# 4. Post an authentic Reply/Comment on a related Twitter/X post
curl -X POST http://localhost:5000/api/tasks \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"AI Marketing Twitter Campaign\",\"sessionId\":\"my-twitter-account\",\"task\":\"twitter-marketing\",\"prompt\":\"Find recent tweets discussing AI marketing tools. Write an authentic, value-adding reply under 280 characters.\",\"runNow\":true}"
```

To schedule a recurring task every 6 hours:

```bash
curl -X POST http://localhost:5000/api/tasks \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Fitness Marketing Schedule\",\"sessionId\":\"my-quora-account\",\"task\":\"quora-marketing\",\"prompt\":\"Find recent Quora questions about fitness.\",\"everyHours\":6}"
```

Trigger an on-demand run of a saved task:

```bash
curl -X POST http://localhost:5000/api/tasks/TASK_ID/run
```

Delete a task to stop its recurring schedule:

```bash
curl -X DELETE http://localhost:5000/api/tasks/TASK_ID
```

## Check Execution & Results

```bash
curl http://localhost:5000/api/executions/EXECUTION_ID
```

Contains:
- `steps`: `session`, `search`, `extract`, `rank`, `open`, `generate`, `validate`, `submit`, `verify`
- `ai.callCount`: number of actual Groq API requests performed
- `ai.calls`: tokens, duration, and model details
- `proof.proofUrl` and `proof.screenshotPath`: link and snapshot of the published answer
- `failure`: records stage, page URL, and sanitized reason if stopped

List failed executions:

```bash
curl "http://localhost:5000/api/executions?status=FAILED"
```

List published content history:

```bash
curl http://localhost:5000/api/publications
```

## Postman Collection

Import `postman/quora-marketing.postman_collection.json` into Postman. Requests are pre-configured in order:
1. `01 List platforms`
2. `02 List available tasks`
3. `03 Create session` (automatically sets `{{sessionId}}` and `{{sessionMongoId}}`)
4. `04 Login session` (auto-stops old Chrome, opens browser)
5. `05 Confirm session` (detects login, auto-closes browser)
6. `08 Create task and run now`
7. `09 Get execution status and logs`
8. `12 List publications`
9. `13 Create scheduled task`
