require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());
const configured = !!KEY && KEY !== 'your_key_here';

const SYSTEM = `You are StudyMate AI Tutor, a friendly, patient and encouraging assistant inside the StudyMate learning website for students, many of them in Cameroon.
- Talk naturally about anything the student wants: greetings, general knowledge, everyday chat, writing, programming. You are not limited to school topics.
- When teaching, explain simply first, then go deeper. Use relatable examples (including local ones such as maize, cocoa, Douala, Yaoundé). Adapt to the student's level; if unclear, ask briefly.
- Solve maths and science problems step by step and say why each step is done. Correct mistakes kindly and explain the error.
- Support Cameroon GCE Ordinary and Advanced Level preparation: past-paper style questions, marking-scheme style answers, revision notes, quizzes and interactive revision (ask one question at a time, then give feedback).
- Use the earlier messages in the conversation to answer follow-ups like "make it simpler" or "give an example".
- Format with short paragraphs, **bold** key terms, lists and fenced code blocks where useful. Be honest when unsure; never invent facts.
- Decline only genuinely harmful requests, and do so kindly. Help with learning but encourage students to understand rather than just copy answers.`;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many messages. Please wait a minute and try again.' } }));
app.use('/api/', (req, res, next) => {
  const o = req.get('origin');
  if (o && !ORIGINS.includes(o)) return res.status(403).json({ error: 'Origin not allowed.' });
  next();
});

app.get('/api/health', (_req, res) => res.json({ configured, model: MODEL }));

function buildMessages(input) {
  if (!Array.isArray(input) || !input.length || input.length > 40) throw new Error('Invalid conversation.');
  const out = input.map(m => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string') throw new Error('Invalid message.');
    const text = m.text.trim().slice(0, 8000);
    const imgs = Array.isArray(m.images) ? m.images.slice(0, 3) : [];
    const blocks = [];
    for (const im of imgs) {
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(im.media_type) ||
          typeof im.data !== 'string' || im.data.length > 5_000_000) throw new Error('Unsupported image.');
      blocks.push({ type: 'image_url', image_url: { url: `data:${im.media_type};base64,${im.data}` } });
    }
    if (text) blocks.push({ type: 'text', text });
    if (!blocks.length) throw new Error('Empty message.');
    return { role: m.role, content: blocks.length === 1 && blocks[0].type === 'text' ? text : blocks };
  });
  if (out[0].role !== 'user' || out[out.length - 1].role !== 'user') throw new Error('Invalid conversation order.');
  return out;
}

app.post('/api/chat', async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'AI is not configured. Add OPENROUTER_API_KEY on the server.' });
  let messages;
  try { messages = buildMessages(req.body.messages); } catch (e) { return res.status(400).json({ error: e.message }); }

  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY, 'X-Title': 'StudyMate AI Tutor' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, stream: true,
        messages: [{ role: 'system', content: SYSTEM }, ...messages] })
    });
    if (!r.ok) {
      console.error('Provider error', r.status, await r.text());
      const msg = r.status === 401 ? 'The server API key is invalid.' :
                  r.status === 402 ? 'The AI account has no credit for this model.' :
                  r.status === 429 ? 'The free AI limit was reached. Please try again later.' : 'The AI service had a problem. Please try again.';
      return res.status(502).json({ error: msg });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('data:')) continue;
        const d = l.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          if (j.error) { send({ type: 'error' }); continue; }
          const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (t) send({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } });
        } catch (_) {}
      }
    }
    res.end();
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    if (!res.headersSent) res.status(502).json({ error: 'Could not reach the AI service. Check your connection.' });
    else res.end();
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () =>
  console.log(`StudyMate AI Tutor on port ${process.env.PORT || 3000} | AI ${configured ? 'configured (' + MODEL + ')' : 'NOT configured'}`));
