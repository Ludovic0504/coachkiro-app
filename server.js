const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TIKTOK_CLIENT_KEY,
  TIKTOK_CLIENT_SECRET,
  BASE_URL = 'http://localhost:3000',
  PORT = 3000,
} = process.env;

if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
  console.error('Missing TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET environment variables.');
  process.exit(1);
}

const REDIRECT_URI = `${BASE_URL.replace(/\/$/, '')}/auth/callback`;
const SECURE = BASE_URL.startsWith('https://');
const MAX_VIDEO_BYTES = 64 * 1024 * 1024; // single-chunk upload limit

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_VIDEO_BYTES },
});

// ---- tiny in-memory sessions (single-user tool) ----
const sessions = new Map();

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function cookieOpts(maxAgeMs) {
  return { httpOnly: true, sameSite: 'lax', secure: SECURE, maxAge: maxAgeMs };
}

function getSession(req) {
  const sid = parseCookies(req).sid;
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return s;
}

function requireSession(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'not_logged_in' });
  req.tt = s;
  next();
}

// ---- TikTok helper ----
async function tiktok(url, token, body) {
  const r = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}

function isOk(json) {
  return json && json.error && json.error.code === 'ok';
}

// ---- Auth ----
app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, cookieOpts(10 * 60 * 1000));
  const params = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    scope: 'user.info.basic,video.publish',
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    state,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description: desc } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(desc || error)}`);
  const expected = parseCookies(req).oauth_state;
  if (!code || !state || state !== expected) {
    return res.redirect('/?error=' + encodeURIComponent('Invalid login state, please try again.'));
  }
  try {
    const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await r.json();
    if (!data.access_token) {
      return res.redirect('/?error=' + encodeURIComponent(data.error_description || 'Token exchange failed'));
    }
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, {
      accessToken: data.access_token,
      openId: data.open_id,
      expiresAt: Date.now() + (data.expires_in || 86400) * 1000,
    });
    res.cookie('sid', sid, cookieOpts((data.expires_in || 86400) * 1000));
    res.clearCookie('oauth_state');
    res.redirect('/');
  } catch (e) {
    res.redirect('/?error=' + encodeURIComponent('Login failed: ' + e.message));
  }
});

app.post('/auth/logout', (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) sessions.delete(sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

// ---- API ----
app.get('/api/me', requireSession, async (req, res) => {
  try {
    const json = await tiktok(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name',
      req.tt.accessToken
    );
    if (!isOk(json)) return res.status(502).json(json);
    res.json(json.data.user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/creator-info', requireSession, async (req, res) => {
  try {
    const json = await tiktok(
      'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
      req.tt.accessToken,
      {}
    );
    if (!isOk(json)) return res.status(502).json(json);
    res.json(json.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/publish', requireSession, upload.single('video'), async (req, res) => {
  const file = req.file;
  const cleanup = () => file && fs.promises.unlink(file.path).catch(() => {});
  try {
    if (!file) return res.status(400).json({ error: 'No video file received.' });
    const b = req.body;
    if (!b.privacy_level) return res.status(400).json({ error: 'Please choose a privacy level.' });
    if (b.consent !== 'true') return res.status(400).json({ error: 'Please confirm before posting.' });

    const size = file.size;
    const init = await tiktok('https://open.tiktokapis.com/v2/post/publish/video/init/', req.tt.accessToken, {
      post_info: {
        title: (b.title || '').slice(0, 2200),
        privacy_level: b.privacy_level,
        disable_comment: b.disable_comment === 'true',
        disable_duet: b.disable_duet === 'true',
        disable_stitch: b.disable_stitch === 'true',
        brand_content_toggle: b.brand_content_toggle === 'true',
        brand_organic_toggle: b.brand_organic_toggle === 'true',
        is_aigc: b.is_aigc === 'true',
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: size,
        total_chunk_count: 1,
      },
    });
    if (!isOk(init)) {
      await cleanup();
      return res.status(502).json(init);
    }

    const { publish_id: publishId, upload_url: uploadUrl } = init.data;
    const buf = await fs.promises.readFile(file.path);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.mimetype || 'video/mp4',
        'Content-Range': `bytes 0-${size - 1}/${size}`,
      },
      body: buf,
    });
    await cleanup();
    if (!put.ok && put.status !== 201) {
      return res.status(502).json({ error: `Upload to TikTok failed (HTTP ${put.status}).` });
    }
    res.json({ publish_id: publishId });
  } catch (e) {
    await cleanup();
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status/:publishId', requireSession, async (req, res) => {
  try {
    const json = await tiktok(
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      req.tt.accessToken,
      { publish_id: req.params.publishId }
    );
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Video too large (64 MB maximum).' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Coach Kiro Publisher running on ${BASE_URL} (port ${PORT})`);
  console.log(`Redirect URI to register in TikTok: ${REDIRECT_URI}`);
});
