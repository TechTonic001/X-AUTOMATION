require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
});
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const model = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash';

const topics = [
  'React hooks and stale closures',
  'Node.js rate limiting under real traffic',
  'PostgreSQL indexing and query plans',
  'Database schema design for multi-tenant SaaS',
  'CI/CD pipelines that fail safely',
  'API pagination and cursor design',
  'Vercel cold starts and serverless tradeoffs',
  'Redis caching invalidation',
  'TypeScript type design at service boundaries',
  'Docker image size and build performance',
  'Webhooks, retries, and idempotency',
  'Observability for background jobs',
  'Authentication sessions versus JWTs',
  'Event-driven architecture in B2B SaaS',
  'React rendering performance'
];

app.use(express.json());

function chooseTopic(recentTopics) {
  const available = topics.filter((topic) => !recentTopics.has(topic));
  if (available.length === 0) {
    const error = new Error('Every configured topic was used in the last 14 days.');
    error.status = 409;
    throw error;
  }
  return available[Math.floor(Math.random() * available.length)];
}

async function getRecentTopics() {
  const result = await pool.query(
    `SELECT DISTINCT topic
     FROM generated_posts
     WHERE created_at >= NOW() - INTERVAL '14 days'`
  );
  return new Set(result.rows.map((row) => row.topic));
}

async function generatePost(postType = 'Value', affiliateDetails = {}) {
  if (!process.env.DATABASE_URL || !ai) {
    const error = new Error('Set DATABASE_URL and GEMINI_API_KEY in .env before generating.');
    error.status = 503;
    throw error;
  }

  const topic = chooseTopic(await getRecentTopics());
  const systemInstruction = [
    'You are a senior full-stack engineer.',
    `Write a highly technical, engaging Twitter/X thread about ${topic}.`,
    'Do not use hashtags, emojis, or corporate buzzwords.',
    'Write like a cynical but helpful developer who has operated production systems.',
    'Use markdown and separate each tweet with a blank line and a line containing --- .',
    'Keep each tweet under 280 characters. Produce 6 to 9 tweets.',
    'Start with a sharp claim, include concrete implementation details, and end with a practical conclusion.',
    postType === 'Affiliate_Promotion'
      ? [
        `Target problem: ${affiliateDetails.targetProblem}`,
        `Solution tool: ${affiliateDetails.solutionTool}`,
        `Actionable link: ${affiliateDetails.actionableLink}`,
        'Follow this exact progression: hook with an unpopular opinion or frustrating reality; agitation explaining why the manual approach is painful; pivot introducing the solution tool and exactly how it helps this problem; final tweet with a casual call to action containing the actionable link.',
        'Clearly disclose that the link is an affiliate promotion without sounding like a marketer.',
        'Do not invent product features, prices, results, or claims that were not provided.'
      ].join(' ')
      : 'Keep the thread educational and do not include a product pitch.'
  ].join(' ');

  const request = {
    contents: `Topic: ${topic}`,
    config: { systemInstruction, temperature: 0.85 }
  };
  let response;
  try {
    response = await ai.models.generateContent({ ...request, model });
  } catch (error) {
    const message = String(error.message || error);
    const canFallback = model !== fallbackModel && /(?:503|UNAVAILABLE|NOT_FOUND|high demand|no longer available)/i.test(message);
    if (!canFallback) throw error;
    console.warn(`Gemini model ${model} unavailable; retrying with ${fallbackModel}.`);
    response = await ai.models.generateContent({ ...request, model: fallbackModel });
  }
  const content = response.text?.trim();
  if (!content) throw new Error('Gemini returned an empty draft.');

  const saved = await pool.query(
    `INSERT INTO generated_posts (topic, content, post_type)
     VALUES ($1, $2, $3)
     RETURNING id, topic, content, post_type, created_at`,
    [topic, content, postType]
  );
  return saved.rows[0];
}

async function getLatestPost() {
  const result = await pool.query(
    `SELECT id, topic, content, post_type, created_at
     FROM generated_posts
     ORDER BY created_at DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

app.get('/api/latest', async (_request, response, next) => {
  try {
    response.json({ post: await getLatestPost() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/generate', async (request, response, next) => {
  try {
    const postType = request.body?.postType || 'Value';
    if (!['Value', 'Affiliate_Promotion'].includes(postType)) {
      return response.status(400).json({ error: 'Invalid post type.' });
    }
    const affiliateDetails = {
      targetProblem: String(request.body?.targetProblem || '').trim(),
      solutionTool: String(request.body?.solutionTool || '').trim(),
      actionableLink: String(request.body?.actionableLink || '').trim()
    };
    if (postType === 'Affiliate_Promotion') {
      if (!affiliateDetails.targetProblem || !affiliateDetails.solutionTool || !affiliateDetails.actionableLink) {
        return response.status(400).json({ error: 'Affiliate posts require a target problem, solution tool, and actionable link.' });
      }
      try {
        const link = new URL(affiliateDetails.actionableLink);
        if (!['http:', 'https:'].includes(link.protocol)) throw new Error();
      } catch {
        return response.status(400).json({ error: 'Actionable link must be a valid http or https URL.' });
      }
    }
    response.status(201).json({ post: await generatePost(postType, affiliateDetails) });
  } catch (error) {
    next(error);
  }
});

app.get('/', (_request, response) => {
  response.type('html').send(HTML);
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: error.message || 'Unexpected server error.' });
});

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Thread Studio</title>
  <style>
    :root { --ink: #17252b; --muted: #607178; --paper: #f4f1ea; --panel: #fffdf8; --line: #d9d5ca; --accent: #df5b38; --accent-dark: #a83e26; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: radial-gradient(circle at 90% 0%, #e8d6bd 0, transparent 32%), var(--paper); font: 16px/1.5 Georgia, serif; }
    main { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 58px 0 80px; }
    .masthead { display: flex; justify-content: space-between; gap: 24px; align-items: end; border-bottom: 1px solid var(--line); padding-bottom: 24px; }
    .kicker { color: var(--accent-dark); font: 700 12px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 0; text-transform: uppercase; }
    h1 { margin: 8px 0 0; font-size: clamp(2.5rem, 7vw, 5.5rem); line-height: .92; font-weight: 400; letter-spacing: 0; }
    .sub { max-width: 280px; color: var(--muted); margin: 0; }
    .toolbar { display: flex; gap: 12px; align-items: center; padding: 24px 0; flex-wrap: wrap; }
    select, input, button { border: 1px solid var(--ink); border-radius: 2px; min-height: 44px; padding: 0 14px; font: 700 13px ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--panel); color: var(--ink); }
    .affiliate-fields { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 12px; width: 100%; }
    .affiliate-fields[hidden] { display: none; }
    button { background: var(--accent); color: #fff; border-color: var(--accent); cursor: pointer; }
    button:hover { background: var(--accent-dark); border-color: var(--accent-dark); }
    button:disabled { opacity: .55; cursor: wait; }
    .status { color: var(--muted); font: 13px ui-monospace, SFMono-Regular, Consolas, monospace; }
    article { background: var(--panel); border: 1px solid var(--line); padding: clamp(22px, 5vw, 48px); min-height: 320px; box-shadow: 10px 10px 0 rgba(23,37,43,.07); }
    .meta { display: flex; justify-content: space-between; gap: 16px; color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; text-transform: uppercase; }
    h2 { margin: 28px 0 20px; font-size: clamp(1.65rem, 4vw, 2.7rem); line-height: 1; font-weight: 400; }
    pre { white-space: pre-wrap; font: 17px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; margin: 0; }
    .empty { color: var(--muted); font-style: italic; }
    @media (max-width: 620px) { main { padding-top: 32px; } .masthead { display: block; } .sub { margin-top: 18px; } .toolbar > * { width: 100%; } .affiliate-fields { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header class="masthead"><div><div class="kicker">Local draft engine / 001</div><h1>Thread<br>Studio</h1></div><p class="sub">Technical ideas with a memory. Built for the person who still reads query plans.</p></header>
    <section class="toolbar" aria-label="Draft controls">
      <select id="postType" aria-label="Post type"><option value="Value">Value thread</option><option value="Affiliate_Promotion">Affiliate promotion</option></select>
      <div class="affiliate-fields" id="affiliateFields" hidden>
        <input id="targetProblem" placeholder="Target problem" aria-label="Target problem">
        <input id="solutionTool" placeholder="Solution tool" aria-label="Solution tool">
        <input id="actionableLink" type="url" placeholder="Actionable link" aria-label="Actionable link">
      </div>
      <button id="generate">Generate draft</button><button id="copy" disabled>Copy to clipboard</button><span class="status" id="status">Loading latest draft...</span>
    </section>
    <article><div class="meta"><span id="type">No draft yet</span><span id="date"></span></div><h2 id="topic">Ready when you are.</h2><pre id="content" class="empty">Generate a draft to put a production-tested opinion in the queue.</pre></article>
  </main>
  <script>
    const topic = document.querySelector('#topic');
    const content = document.querySelector('#content');
    const type = document.querySelector('#type');
    const date = document.querySelector('#date');
    const status = document.querySelector('#status');
    const generate = document.querySelector('#generate');
    const copy = document.querySelector('#copy');
    const postType = document.querySelector('#postType');
    const affiliateFields = document.querySelector('#affiliateFields');
    let latestText = '';
    function showPost(post) {
      if (!post) return;
      latestText = post.content;
      topic.textContent = post.topic;
      content.textContent = post.content;
      content.classList.remove('empty');
      type.textContent = post.post_type.replace('_', ' ');
      date.textContent = new Date(post.created_at).toLocaleString();
      copy.disabled = false;
    }
    postType.addEventListener('change', () => { affiliateFields.hidden = postType.value !== 'Affiliate_Promotion'; });
    async function loadLatest() {
      try { showPost((await (await fetch('/api/latest')).json()).post); status.textContent = 'Memory loaded'; }
      catch (error) { status.textContent = 'Database unavailable'; }
    }
    generate.addEventListener('click', async () => {
      generate.disabled = true; copy.disabled = true; status.textContent = 'Writing a fresh draft...';
      try {
        const result = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          postType: postType.value,
          targetProblem: document.querySelector('#targetProblem').value,
          solutionTool: document.querySelector('#solutionTool').value,
          actionableLink: document.querySelector('#actionableLink').value
        }) });
        const data = await result.json();
        if (!result.ok) throw new Error(data.error);
        showPost(data.post); status.textContent = 'Saved to PostgreSQL';
      } catch (error) { status.textContent = error.message; }
      finally { generate.disabled = false; }
    });
    copy.addEventListener('click', async () => { await navigator.clipboard.writeText(latestText); status.textContent = 'Copied'; });
    loadLatest();
  </script>
</body>
</html>`;

app.listen(port, () => console.log(`Thread Studio listening on http://localhost:${port}`));
