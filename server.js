import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: '5mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'chat-uploads';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const FFMPEG_PRESET = process.env.FFMPEG_PRESET || 'veryfast';
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || '200');

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

function verifySignature(req) {
  if (!WEBHOOK_SECRET) return true;
  const sig = req.headers['x-webhook-signature'];
  if (!sig) return false;
  if (sig === WEBHOOK_SECRET) return true;
  const payload = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function signedStorageUrl(pathname) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${pathname}`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE,
      'Authorization': `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ expiresIn: 600 })
  });
  if (!res.ok) throw new Error(`sign url failed ${res.status}`);
  const data = await res.json();
  return `${SUPABASE_URL}/storage/v1/${data.signedURL.replace(/^\/?/, '')}`;
}

async function uploadToStorage(pathname, buffer, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${pathname}`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE,
      'Authorization': `Bearer ${SERVICE_ROLE}`,
      'Content-Type': contentType
    },
    body: buffer
  });
  if (!res.ok) throw new Error(`upload failed ${res.status}`);
}

async function updateMessage(originalPath, mp4Path, mp4Name) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/messages?attachment_url=eq.${encodeURIComponent(originalPath)}`, {
    method: 'PATCH',
    headers: {
      'apikey': SERVICE_ROLE,
      'Authorization': `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ attachment_url_mp4: mp4Path, attachment_name_mp4: mp4Name })
  });
  if (!res.ok) throw new Error(`messages update failed ${res.status}`);
}

async function transcodeToMp4(inputUrl, outputPath) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcord-'));
  const inputFile = path.join(tmpDir, 'input');
  const outputFile = path.join(tmpDir, 'output.mp4');

  const inputRes = await fetch(inputUrl);
  if (!inputRes.ok) throw new Error(`download failed ${inputRes.status}`);
  const arrayBuffer = await inputRes.arrayBuffer();
  const sizeMb = arrayBuffer.byteLength / (1024 * 1024);
  if (sizeMb > MAX_VIDEO_MB) throw new Error(`file too large ${sizeMb.toFixed(1)}MB`);
  await fs.writeFile(inputFile, Buffer.from(arrayBuffer));

  await execFileAsync('ffmpeg', [
    '-y',
    '-i', inputFile,
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-movflags', 'faststart',
    '-preset', FFMPEG_PRESET,
    outputFile
  ]);

  const outBuf = await fs.readFile(outputFile);
  await uploadToStorage(outputPath, outBuf, 'video/mp4');

  await fs.rm(tmpDir, { recursive: true, force: true });
}

app.post('/webhook/storage', async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.status(401).send('invalid signature');
    }

    const record = req.body?.record;
    if (!record) return res.status(400).send('no record');

    const bucketId = record.bucket_id;
    const name = record.name;
    const mime = record.metadata?.mimetype || '';

    if (bucketId !== STORAGE_BUCKET) return res.status(204).send('skip');

    if (!mime.startsWith('video/')) return res.status(204).send('skip');
    if (/\.mp4$/i.test(name)) return res.status(204).send('skip');
    if (/^transcoded\//i.test(name)) return res.status(204).send('skip');

    const signedUrl = await signedStorageUrl(name);
    const base = name.replace(/\.[^/.]+$/, '');
    const mp4Path = `transcoded/${base}.mp4`;
    const mp4Name = path.basename(mp4Path);

    await transcodeToMp4(signedUrl, mp4Path);
    await updateMessage(name, mp4Path, mp4Name);

    return res.status(200).send('ok');
  } catch (err) {
    console.error(err);
    return res.status(500).send('error');
  }
});

app.get('/health', (req, res) => res.status(200).send('ok'));

app.get('/wordle/today', async (req, res) => {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = fmt.formatToParts(now);
    const y = parts.find(p => p.type === 'year')?.value;
    const m = parts.find(p => p.type === 'month')?.value;
    const d = parts.find(p => p.type === 'day')?.value;
    const date = `${y}-${m}-${d}`;
    const url = `https://www.nytimes.com/svc/wordle/v2/${date}.json`;
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(502).json({ error: 'wordle_fetch_failed' });
    }
    const data = await r.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({ solution: (data?.solution || '').toUpperCase(), date });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ error: 'wordle_error' });
  }
});

app.post('/webhook/notify-email', async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.status(401).send('invalid signature');
    }

    const to = req.body?.email;
    const fromUser = req.body?.from_user || 'Someone';
    const channel = req.body?.channel || '';
    const type = req.body?.type || 'mention';

    if (!to) return res.status(400).json({ error: 'missing_email' });

    const subject =
      type === 'reply'
        ? `${fromUser} replied to you in ${channel}`
        : type === 'everyone'
          ? `${fromUser} mentioned everyone in ${channel}`
          : `${fromUser} mentioned you in ${channel}`;

    const text = `${fromUser} ${type === 'reply' ? 'replied to you' : (type === 'everyone' ? 'mentioned everyone' : 'mentioned you')} in ${channel}.`;

    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    if (!apiKey || !from) {
      return res.status(500).json({ error: 'resend_not_configured' });
    }

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        text
      })
    });

    if (!r.ok) {
      const body = await r.text();
      return res.status(502).json({ error: 'resend_failed', body });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'notify_error' });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`transcoder listening on ${port}`);
});
