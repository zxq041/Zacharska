// server.js
// Node >=18 (fetch built-in). Requires: express, multer, express-session, uuid
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const LISTINGS_FILE = path.join(DATA_DIR, 'listings.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '33201';

// Webhook URL (Elfsight / provided)
const FB_WEBHOOK_URL = process.env.FB_WEBHOOK_URL || 'https://6b71ec7fb3ad4df7b4e6291714fe957f.elf.site';

// Ensure directories exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LISTINGS_FILE)) fs.writeFileSync(LISTINGS_FILE, JSON.stringify([], null, 2), 'utf8');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'replace_this_with_a_real_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // if using https set to true
}));

// Serve static site files
app.use(express.static(path.join(__dirname))); // serves index.html, panel.html etc.

// Serve uploaded images
app.use('/uploads', express.static(UPLOAD_DIR));

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safe = `${Date.now()}-${uuidv4()}${ext}`;
    cb(null, safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 6 * 1024 * 1024 } }); // 6MB limit per file

// Helpers for listings persistence
function readListings() {
  try {
    const raw = fs.readFileSync(LISTINGS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    return [];
  }
}
function writeListings(list) {
  fs.writeFileSync(LISTINGS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// Simple auth endpoints (session-based)
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.auth = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Nieprawidłowe hasło' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ admin: !!req.session.auth });
});

// Listings endpoints
app.get('/api/listings', (req, res) => {
  const list = readListings();
  res.json(list);
});

// Upload multiple images: form field name "images[]" (our panel uses this)
app.post('/api/listings', upload.array('images[]'), (req, res) => {
  if (!req.session.auth) return res.status(403).json({ error: "Brak autoryzacji" });

  try {
    const fields = req.body || {};
    const files = req.files || [];

    // Build images URLs (serve from /uploads)
    const images = files.map(f => `/uploads/${encodeURIComponent(path.basename(f.filename))}`);

    const newListing = {
      id: uuidv4(),
      title: fields.title || '',
      city: fields.city || '',
      type: fields.type || '',
      area: Number(fields.area) || 0,
      rooms: Number(fields.rooms) || 0,
      price: Number(fields.price) || 0,
      floor: fields.floor ? Number(fields.floor) : null,
      terrace: fields.terrace === 'on' || fields.terrace === 'true' || fields.terrace === '1',
      garden: fields.garden === 'on' || fields.garden === 'true' || fields.garden === '1',
      description: fields.description || '',
      images, // array of paths
      createdAt: Date.now()
    };

    const list = readListings();
    list.unshift(newListing); // newest first
    writeListings(list);

    res.json(newListing);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

// Delete listing by id and its images
app.delete('/api/listings/:id', (req, res) => {
  if (!req.session.auth) return res.status(403).json({ error: "Brak autoryzacji" });
  const id = req.params.id;
  const list = readListings();
  const idx = list.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Nie znaleziono oferty' });

  const [removed] = list.splice(idx, 1);
  // remove images from disk
  if (Array.isArray(removed.images)) {
    removed.images.forEach(url => {
      try {
        const fname = path.basename(url);
        const fpath = path.join(UPLOAD_DIR, fname);
        if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
      } catch (e) {}
    });
  }
  writeListings(list);
  res.json({ ok: true });
});

// Proxy /api/facebook-reviews -> your webhook (Elfsight)
let FB_CACHE = { data: null, ts: 0 };
const FB_CACHE_TTL = 60 * 60 * 1000; // 1 hour

app.get('/api/facebook-reviews', async (req, res) => {
  try {
    const now = Date.now();
    if (FB_CACHE.data && (now - FB_CACHE.ts < FB_CACHE_TTL)) {
      return res.json(FB_CACHE.data);
    }

    // Proxy the webhook
    const resp = await fetch(FB_WEBHOOK_URL, { method: 'GET' });
    if (!resp.ok) {
      console.warn('Webhook fetch failed', resp.status);
      return res.json([]);
    }
    const json = await resp.json().catch(() => null);
    // Expect the webhook to return an array of review-like objects.
    // We'll attempt to normalize to format:
    // { author_name, rating, text, time, profile_pic, permalink }
    const items = Array.isArray(json) ? json.map(normalizeWebhookItem) : [];

    FB_CACHE = { data: items, ts: now };
    res.json(items);
  } catch (e) {
    console.error('Error proxying webhook', e);
    res.json([]);
  }
});

function normalizeWebhookItem(src) {
  // Try several common field names, be permissive
  const author_name = src.author_name || src.name || src.reviewer || src.user || '';
  const rating = Number(src.rating || src.stars || (src.recommendation_type === 'positive' ? 5 : (src.recommendation_type === 'negative' ? 1 : 5))) || 0;
  const text = src.text || src.review_text || src.recommendation_text || src.comment || '';
  const time = src.time || src.created_time || src.date || 0;
  const tnum = Number(time) > 1000000000 ? Number(time) : (Date.parse(time) ? Math.floor(Date.parse(time)/1000) : Math.floor(Date.now()/1000));
  const profile_pic = src.profile_pic || src.photo || (src.reviewer && src.reviewer.picture) || null;
  const permalink = src.permalink || src.url || null;
  return { author_name, rating, text, time: tnum, profile_pic, permalink };
}

// -------------------- CUSTOM PANEL ROUTES --------------------
// Serve the admin panel under /panel33201 (expects panel.html in project root)
app.get('/panel33201', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.html'));
});

// Optional convenience redirect
app.get('/panel', (req, res) => res.redirect('/panel33201'));

// -------------------- FALLBACK (SPA) --------------------
app.get('*', (req, res, next) => {
  // let static middleware handle real files
  const filePath = path.join(__dirname, req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/panel33201`);
  console.log(`Facebook webhook proxy endpoint: GET http://localhost:${PORT}/api/facebook-reviews => ${FB_WEBHOOK_URL}`);
});
