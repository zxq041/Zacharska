// server.js — wersja finalna bez logowania, z /panel33201 (fix relative assets + redirects)
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const pg = require("pg");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

// ====== KONFIGURACJA UPLOADU ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
});

// ====== KONFIGURACJA BAZY ======
const { Pool } = pg;
const connectionString =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/postgres";

const pool = new Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false },
});

app.use(cookieParser());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// ====== STATYCZNE PLIKI ======
// Statyki spod root'a (np. /index.html, /oferty.html, /app.js, /styles.css)
app.use(express.static(__dirname));

// Dodatkowo: serwuj statyki POD prefiksem /panel33201, żeby relative pathy działały
// (np. <script src="app.js"> załaduje się jako /panel33201/app.js).
app.use("/panel33201", express.static(__dirname));

// ====== INICjALIZACJA TABEL ======
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      city TEXT NOT NULL,
      district TEXT,
      street TEXT,
      price INTEGER NOT NULL,
      rooms INTEGER NOT NULL,
      area INTEGER NOT NULL,
      type TEXT NOT NULL,
      floor INTEGER,
      balcony BOOLEAN DEFAULT false,
      terrace BOOLEAN DEFAULT false,
      garden BOOLEAN DEFAULT false,
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS images (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL
    );
  `);

  console.log("✅ Baza danych gotowa");
}

initDb().catch((e) => {
  console.error("❌ Błąd połączenia z bazą:", e);
  process.exit(1);
});

// ====== API ZDJĘĆ ======
app.get("/api/images/:id", async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query("SELECT mime, data FROM images WHERE id=$1", [id]);
  if (rows.length === 0) return res.status(404).send("Not found");
  res.setHeader("Content-Type", rows[0].mime);
  res.send(rows[0].data);
});

// ====== API OGŁOSZEŃ ======

// Wszystkie ogłoszenia
app.get("/api/listings", async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT l.*, COALESCE(json_agg(i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS image_ids
    FROM listings l
    LEFT JOIN images i ON i.listing_id = l.id
    GROUP BY l.id
    ORDER BY l.created_at DESC;
  `);
  res.json(rows);
});

// Jedno ogłoszenie
app.get("/api/listings/:id", async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `
    SELECT l.*, COALESCE(json_agg(i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS image_ids
    FROM listings l
    LEFT JOIN images i ON i.listing_id = l.id
    WHERE l.id=$1
    GROUP BY l.id;
  `,
    [id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Nie znaleziono" });
  res.json(rows[0]);
});

// Dodaj ogłoszenie (bez logowania, panel ukryty przez URL)
app.post("/api/listings", upload.array("images", 12), async (req, res) => {
  try {
    const {
      title, city, district, street, price,
      rooms, area, type, floor, balcony,
      terrace, garden, description
    } = req.body;

    const { rows } = await pool.query(
      `
      INSERT INTO listings (title, city, district, street, price, rooms, area, type, floor, balcony, terrace, garden, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *;
    `,
      [
        title, city, district || null, street || null,
        Number(price), Number(rooms), Number(area),
        type, floor ? Number(floor) : null,
        balcony === "true", terrace === "true", garden === "true",
        description || null,
      ]
    );

    const listing = rows[0];

    if (req.files?.length) {
      for (const f of req.files) {
        await pool.query(
          "INSERT INTO images (listing_id, mime, data) VALUES ($1,$2,$3)",
          [listing.id, f.mimetype, f.buffer]
        );
      }
    }

    res.status(201).json({ success: true, listing });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: "Błąd podczas dodawania ogłoszenia" });
  }
});

// Edycja ogłoszenia
app.put("/api/listings/:id", upload.array("images", 12), async (req, res) => {
  const { id } = req.params;
  const {
    title, city, district, street, price,
    rooms, area, type, floor, balcony,
    terrace, garden, description, remove_images
  } = req.body;

  try {
    await pool.query(
      `
      UPDATE listings SET
      title=$1, city=$2, district=$3, street=$4, price=$5, rooms=$6,
      area=$7, type=$8, floor=$9, balcony=$10, terrace=$11, garden=$12, description=$13
      WHERE id=$14;
    `,
      [
        title, city, district || null, street || null,
        Number(price), Number(rooms), Number(area),
        type, floor ? Number(floor) : null,
        balcony === "true", terrace === "true", garden === "true",
        description || null, id,
      ]
    );

    if (remove_images) {
      let arr = [];
      try {
        arr = JSON.parse(remove_images);
      } catch {}
      if (Array.isArray(arr) && arr.length) {
        await pool.query(
          "DELETE FROM images WHERE listing_id=$1 AND id = ANY($2::int[])",
          [id, arr]
        );
      }
    }

    if (req.files?.length) {
      for (const f of req.files) {
        await pool.query(
          "INSERT INTO images (listing_id, mime, data) VALUES ($1,$2,$3)",
          [id, f.mimetype, f.buffer]
        );
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: "Błąd aktualizacji" });
  }
});

// Usuń ogłoszenie
app.delete("/api/listings/:id", async (req, res) => {
  const { id } = req.params;
  await pool.query("DELETE FROM listings WHERE id=$1", [id]);
  res.json({ success: true });
});

// ====== ROUTING STRON ======

// Helper: no-cache dla HTML (zapobiega białym ekranom po deployu przez cache)
function noCacheHtml(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

// Strona główna
app.get("/", (_req, res) => {
  noCacheHtml(res);
  res.sendFile(path.join(__dirname, "index.html"));
});

// Zwykłe oferty
app.get("/oferty.html", (_req, res) => {
  noCacheHtml(res);
  res.sendFile(path.join(__dirname, "oferty.html"));
});

// Panel administracyjny — renderuj panel dla /panel33201 i dowolnych pod-ścieżek
app.get(["/panel33201", "/panel33201/*"], (_req, res) => {
  noCacheHtml(res);
  res.sendFile(path.join(__dirname, "oferty.html"));
});

// Przekierowanie starego adresu /panel → /panel33201 (301)
app.get("/panel", (_req, res) => {
  res.redirect(301, "/panel33201");
});

// Healthcheck (dla Railway)
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ====== START SERVERA ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serwer działa na porcie ${PORT}`));
