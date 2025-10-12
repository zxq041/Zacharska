// server.js
// -----------------------------
// Real Estate server for Railway
// - Static pages: index.html, oferty.html (/oferty), panel (/panel -> oferty.html)
// - API:
//   GET  /api/listings?q=...          -> list with computed image url
//   POST /api/listings                -> create (multipart), REQUIRES admin
//   DELETE /api/listings/:id          -> delete, REQUIRES admin
//   GET  /api/images/:id              -> serve image bytes from DB
// - Auth: header x-admin-pass (or body/query adminPass)
// - Images stored in Postgres BYTEA (table images)
// -----------------------------

const express = require('express');
const path = require('path');
const multer = require('multer');
const { Pool } = require('pg');

require('dotenv').config?.(); // safe if dotenv not installed

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'Klaudia0050';
const DATABASE_URL = process.env.DATABASE_URL;

// Postgres pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes('railway.app') ? { rejectUnauthorized: false } : undefined,
});

// Create tables if not exist
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS images (
      id SERIAL PRIMARY KEY,
      filename TEXT,
      mimetype TEXT,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listings (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      title TEXT NOT NULL,
      description TEXT,
      city TEXT,
      district TEXT,
      street TEXT,
      type TEXT,
      price NUMERIC,
      rooms INT,
      area NUMERIC,
      floor INT,
      balcony BOOLEAN DEFAULT FALSE,
      terrace BOOLEAN DEFAULT FALSE,
      garden  BOOLEAN DEFAULT FALSE,
      image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
      image_url TEXT
    );
  `);
}
initDb().catch((e) => {
  console.error('DB init error:', e);
  process.exit(1);
});

// ---------- AUTH ----------
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-pass'] || req.body?.adminPass || req.query?.adminPass;
  if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ---------- MULTER (memory -> DB) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ---------- HELPERS ----------
function mapRowToListing(row) {
  // Zwracamy ujednolicone "image" do frontu: /api/images/:id lub image_url
  return {
    id: Number(row.id),
    createdAt: new Date(row.created_at).getTime(),
    title: row.title,
    description: row.description || '',
    city: row.city || '',
    district: row.district || '',
    street: row.street || '',
    type: row.type || 'Mieszkanie',
    price: row.price !== null ? Number(row.price) : 0,
    rooms: row.rooms !== null ? Number(row.rooms) : 0,
    area: row.area !== null ? Number(row.area) : 0,
    floor: row.floor !== null ? Number(row.floor) : 0,
    balcony: !!row.balcony,
    terrace: !!row.terrace,
    garden: !!row.garden,
    image: row.image_id ? `/api/images/${row.image_id}` : (row.image_url || ''),
  };
}

// ---------- API: LISTINGS ----------
app.get('/api/listings', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let sql = `SELECT * FROM listings`;
    const values = [];
    if (q) {
      // proste szukanie po kilku kolumnach
      sql += ` WHERE
        (title ILIKE $1 OR city ILIKE $1 OR type ILIKE $1 OR district ILIKE $1 OR street ILIKE $1
         OR CAST(price AS TEXT) ILIKE $1 OR CAST(rooms AS TEXT) ILIKE $1 OR CAST(area AS TEXT) ILIKE $1
        )`;
      values.push(`%${q}%`);
    }
    sql += ` ORDER BY created_at DESC`;
    const { rows } = await pool.query(sql, values);
    res.json(rows.map(mapRowToListing));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/listings', requireAdmin, upload.single('imageFile'), async (req, res) => {
  try {
    // 1) jeśli jest plik — zapisujemy do images
    let imageId = null;
    if (req.file && req.file.buffer?.length) {
      const { originalname, mimetype, buffer } = req.file;
      const insertImg = await pool.query(
        `INSERT INTO images (filename, mimetype, data) VALUES ($1, $2, $3) RETURNING id`,
        [originalname, mimetype, buffer]
      );
      imageId = insertImg.rows[0].id;
    }

    // 2) pozostałe pola
    const b = req.body;
    const data = {
      title: b.title || '',
      description: b.description || '',
      city: b.city || '',
      district: b.district || '',
      street: b.street || '',
      type: b.type || 'Mieszkanie',
      price: b.price ? Number(b.price) : null,
      rooms: b.rooms ? Number(b.rooms) : null,
      area: b.area ? Number(b.area) : null,
      floor: b.floor ? Number(b.floor) : null,
      balcony: ['true', 'on', true, '1', 1].includes(b.balcony),
      terrace: ['true', 'on', true, '1', 1].includes(b.terrace),
      garden:  ['true', 'on', true, '1', 1].includes(b.garden),
      image_url: b.imageUrl || null,
      image_id: imageId,
    };

    const insert = await pool.query(
      `INSERT INTO listings
        (title, description, city, district, street, type, price, rooms, area, floor,
         balcony, terrace, garden, image_id, image_url)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        data.title, data.description, data.city, data.district, data.street, data.type,
        data.price, data.rooms, data.area, data.floor,
        data.balcony, data.terrace, data.garden, data.image_id, data.image_url
      ]
    );

    res.status(201).json(mapRowToListing(insert.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/listings/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT image_id FROM listings WHERE id = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const imgId = rows[0].image_id;
    await pool.query(`DELETE FROM listings WHERE id = $1`, [id]);
    if (imgId) await pool.query(`DELETE FROM images WHERE id = $1`, [imgId]);

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- API: IMAGES (serve bytes from DB) ----------
app.get('/api/images/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT mimetype, data FROM images WHERE id = $1`, [id]);
    if (rows.length === 0) return res.status(404).send('Not Found');
    res.setHeader('Content-Type', rows[0].mimetype || 'application/octet-stream');
    res.send(rows[0].data);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

// ---------- STATIC PAGES ----------
app.use(express.static(__dirname));

// root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// list & panel (panel jest w oferty.html; front pokazuje login)
app.get(['/oferty', '/panel'], (req, res) => {
  res.sendFile(path.join(__dirname, 'oferty.html'));
});

// 404
app.use((_, res) => res.status(404).send('Not Found'));

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
