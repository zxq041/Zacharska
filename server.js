// server.js
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");
const multer = require("multer");

const app = express();
app.use(express.json());
app.use(cookieParser());

// --- DB ---
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASS = process.env.ADMIN_PASS || "Klaudia0050";

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env var.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Railway PG
});

// create tables
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      city TEXT NOT NULL,
      district TEXT,
      street TEXT,
      price INTEGER NOT NULL,
      rooms INTEGER,
      area INTEGER,
      type TEXT,
      floor INTEGER,
      balcony BOOLEAN DEFAULT false,
      terrace BOOLEAN DEFAULT false,
      garden BOOLEAN DEFAULT false,
      description TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS images (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);
}
initDb().catch((e) => {
  console.error("DB init error:", e);
  process.exit(1);
});

// --- STATIC (index.html, oferty.html) ---
app.use(express.static(path.join(__dirname)));

// --- PANEL AUTH ---
app.post("/api/panel/login", (req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { password } = JSON.parse(body || "{}");
      if (password === ADMIN_PASS) {
        // prosty cookie token (na 24h)
        res.cookie("admin", "1", { httpOnly: true, sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 });
        return res.json({ ok: true });
      }
      return res.status(401).json({ ok: false, error: "Nieprawidłowe hasło" });
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid body" });
    }
  });
});

app.post("/api/panel/logout", (req, res) => {
  res.clearCookie("admin");
  res.json({ ok: true });
});

app.get("/api/panel/me", (req, res) => {
  res.json({ authed: req.cookies.admin === "1" });
});

// --- MULTER (upload do RAM, potem do PG BYTEA) ---
const upload = multer({ storage: multer.memoryStorage() });

// --- HELPERS ---
function requireAdmin(req, res, next) {
  if (req.cookies.admin !== "1") return res.status(401).json({ error: "Unauthorized" });
  next();
}

// --- LISTINGS API ---

// GET /api/listings (lista + miniatury)
app.get("/api/listings", async (req, res) => {
  const { q, city, type, min_area, max_area, min_price, max_price, rooms } = req.query;

  const filters = [];
  const params = [];
  let i = 1;

  if (q)        { filters.push(`title ILIKE $${i++}`); params.push(`%${q}%`); }
  if (city)     { filters.push(`city = $${i++}`); params.push(city); }
  if (type)     { filters.push(`type = $${i++}`); params.push(type); }
  if (rooms)    { filters.push(`rooms >= $${i++}`); params.push(Number(rooms)); }
  if (min_area) { filters.push(`area >= $${i++}`); params.push(Number(min_area)); }
  if (max_area) { filters.push(`area <= $${i++}`); params.push(Number(max_area)); }
  if (min_price){ filters.push(`price >= $${i++}`); params.push(Number(min_price)); }
  if (max_price){ filters.push(`price <= $${i++}`); params.push(Number(max_price)); }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = (await pool.query(
    `
    SELECT l.*,
      (SELECT i.id FROM images i WHERE i.listing_id = l.id ORDER BY i.id ASC LIMIT 1) AS thumb_image_id,
      (SELECT COUNT(*)::int FROM images i WHERE i.listing_id = l.id) AS images_count
    FROM listings l
    ${where}
    ORDER BY l.created_at DESC
    `
    , params)).rows;

  res.json(rows);
});

// GET /api/listings/:id (ze zdjęciami)
app.get("/api/listings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query(`SELECT * FROM listings WHERE id=$1`, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });

  const imgs = (await pool.query(
    `SELECT id, content_type FROM images WHERE listing_id=$1 ORDER BY id ASC`, [id]
  )).rows;

  res.json({ ...rows[0], images: imgs });
});

// POST /api/listings (dodanie z wieloma zdjęciami) [admin]
app.post("/api/listings", requireAdmin, upload.array("images", 20), async (req, res) => {
  const {
    title, city, district, street, price,
    rooms, area, type, floor, balcony, terrace, garden, description
  } = req.body;

  if (!title || !city || !price) {
    return res.status(400).json({ error: "Brak wymaganych pól: title, city, price" });
  }

  const { rows } = await pool.query(
    `INSERT INTO listings
      (title, city, district, street, price, rooms, area, type, floor, balcony, terrace, garden, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      title,
      city,
      district || null,
      street || null,
      Number(price),
      rooms ? Number(rooms) : null,
      area ? Number(area) : null,
      type || null,
      floor ? Number(floor) : null,
      balcony === "true",
      terrace === "true",
      garden === "true",
      description || null,
    ]
  );

  const listingId = rows[0].id;

  // zdjęcia
  for (const file of req.files || []) {
    await pool.query(
      `INSERT INTO images (listing_id, content_type, bytes) VALUES ($1,$2,$3)`,
      [listingId, file.mimetype || "image/jpeg", file.buffer]
    );
  }

  res.json({ ok: true, id: listingId });
});

// PUT /api/listings/:id (edycja; opcjonalnie dodanie kolejnych zdjęć) [admin]
app.put("/api/listings/:id", requireAdmin, upload.array("images", 20), async (req, res) => {
  const id = Number(req.params.id);

  const {
    title, city, district, street, price,
    rooms, area, type, floor, balcony, terrace, garden, description
  } = req.body;

  // aktualizacja pól (zachowujemy poprzednie jeśli undefined)
  const { rows: curRows } = await pool.query(`SELECT * FROM listings WHERE id=$1`, [id]);
  if (!curRows[0]) return res.status(404).json({ error: "Not found" });
  const cur = curRows[0];

  await pool.query(
    `UPDATE listings SET
      title=$1, city=$2, district=$3, street=$4, price=$5,
      rooms=$6, area=$7, type=$8, floor=$9,
      balcony=$10, terrace=$11, garden=$12, description=$13
     WHERE id=$14`,
    [
      title ?? cur.title,
      city ?? cur.city,
      district ?? cur.district,
      street ?? cur.street,
      price !== undefined ? Number(price) : cur.price,
      rooms !== undefined ? Number(rooms) : cur.rooms,
      area !== undefined ? Number(area) : cur.area,
      type ?? cur.type,
      floor !== undefined ? Number(floor) : cur.floor,
      balcony !== undefined ? (String(balcony) === "true") : cur.balcony,
      terrace !== undefined ? (String(terrace) === "true") : cur.terrace,
      garden !== undefined ? (String(garden) === "true") : cur.garden,
      description ?? cur.description,
      id
    ]
  );

  // ewentualne nowe zdjęcia
  for (const file of req.files || []) {
    await pool.query(
      `INSERT INTO images (listing_id, content_type, bytes) VALUES ($1,$2,$3)`,
      [id, file.mimetype || "image/jpeg", file.buffer]
    );
  }

  res.json({ ok: true });
});

// DELETE /api/listings/:id [admin]
app.delete("/api/listings/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query(`DELETE FROM listings WHERE id=$1`, [id]);
  res.json({ ok: true });
});

// DELETE /api/images/:id [admin]
app.delete("/api/images/:id", requireAdmin, async (req, res) => {
  const imgId = Number(req.params.id);
  await pool.query(`DELETE FROM images WHERE id=$1`, [imgId]);
  res.json({ ok: true });
});

// GET /api/images/:id (serwowanie obrazka)
app.get("/api/images/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query(`SELECT content_type, bytes FROM images WHERE id=$1`, [id]);
  if (!rows[0]) return res.status(404).send("Not found");
  res.setHeader("Content-Type", rows[0].content_type || "image/jpeg");
  res.send(rows[0].bytes);
});

// --- ROUTES FOR STATIC PAGES ---
// /panel ma zwrócić oferty.html (ten sam plik), a React w środku pokaże panel jeśli ścieżka kończy się /panel
app.get("/panel", (req, res) => {
  res.sendFile(path.join(__dirname, "oferty.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server on http://0.0.0.0:" + PORT));
