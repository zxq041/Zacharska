// server.js (CommonJS)
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const pg = require("pg");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

// --- Upload: wiele plików do 10 MB każdy ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
});

// --- DB (Railway Postgres) ---
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
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- STATIC z katalogu głównego repo ----
app.use(express.static(__dirname));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Klaudia0050";

// --- DB init ---
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

  console.log("DB ready");
}
initDb().catch((e) => {
  console.error("DB init error:", e);
  process.exit(1);
});

// --- Auth middleware ---
function requireAdmin(req, res, next) {
  if (req.cookies?.admin_auth === "true") return next();
  res.status(403).json({ error: "Brak dostępu" });
}

// --- Auth endpoints ---
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    res.cookie("admin_auth", "true", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60, // 1h
      secure: process.env.NODE_ENV === "production",
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Błędne hasło" });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("admin_auth");
  res.json({ ok: true });
});

// --- Images serving ---
app.get("/api/images/:id", async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    "SELECT mime, data FROM images WHERE id=$1",
    [id]
  );
  if (rows.length === 0) return res.status(404).send("Not found");
  res.setHeader("Content-Type", rows[0].mime);
  res.send(rows[0].data);
});

// --- Listings: list + one ---
app.get("/api/listings", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*,
            COALESCE(json_agg(i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS image_ids
     FROM listings l
     LEFT JOIN images i ON i.listing_id = l.id
     GROUP BY l.id
     ORDER BY l.created_at DESC;`
  );
  res.json(rows);
});

app.get("/api/listings/:id", async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT l.*,
            COALESCE(json_agg(i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS image_ids
     FROM listings l
     LEFT JOIN images i ON i.listing_id = l.id
     WHERE l.id=$1
     GROUP BY l.id;`,
    [id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

// --- Create (multi images) ---
app.post(
  "/api/listings",
  requireAdmin,
  upload.array("images", 12),
  async (req, res) => {
    try {
      const {
        title,
        city,
        district,
        street,
        price,
        rooms,
        area,
        type,
        floor,
        balcony,
        terrace,
        garden,
        description,
      } = req.body;

      const { rows } = await pool.query(
        `INSERT INTO listings (title, city, district, street, price, rooms, area, type, floor, balcony, terrace, garden, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *;`,
        [
          title,
          city,
          district || null,
          street || null,
          Number(price),
          Number(rooms),
          Number(area),
          type,
          floor ? Number(floor) : null,
          balcony === "true",
          terrace === "true",
          garden === "true",
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

      const { rows: out } = await pool.query(
        `SELECT l.*,
                COALESCE(json_agg(i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS image_ids
         FROM listings l
         LEFT JOIN images i ON i.listing_id = l.id
         WHERE l.id=$1
         GROUP BY l.id;`,
        [listing.id]
      );
      res.status(201).json(out[0]);
    } catch (e) {
      console.error(e);
      res.status(400).json({ error: "Błąd zapisu ogłoszenia" });
    }
  }
);

// --- Update + add/remove images ---
app.put(
  "/api/listings/:id",
  requireAdmin,
  upload.array("images", 12),
  async (req, res) => {
    const { id } = req.params;
    const {
      title,
      city,
      district,
      street,
      price,
      rooms,
      area,
      type,
      floor,
      balcony,
      terrace,
      garden,
      description,
      remove_images,
    } = req.body;

    try {
      await pool.query(
        `UPDATE listings SET
          title=$1, city=$2, district=$3, street=$4, price=$5, rooms=$6, area=$7,
          type=$8, floor=$9, balcony=$10, terrace=$11, garden=$12, description=$13
         WHERE id=$14`,
        [
          title,
          city,
          district || null,
          street || null,
          Number(price),
          Number(rooms),
          Number(area),
          type,
          floor ? Number(floor) : null,
          balcony === "true",
          terrace === "true",
          garden === "true",
          description || null,
          id,
        ]
      );

      // usuwanie wskazanych zdjęć
      if (remove_images) {
        let arr = [];
        try {
          arr = JSON.parse(remove_images);
        } catch {}
        if (Array.isArray(arr) && arr.length) {
          await pool.query(
            `DELETE FROM images WHERE listing_id=$1 AND id = ANY($2::int[])`,
            [id, arr]
          );
        }
      }

      // dodawanie nowych zdjęć
      if (req.files?.length) {
        for (const f of req.files) {
          await pool.query(
            "INSERT INTO images (listing_id, mime, data) VALUES ($1,$2,$3)",
            [id, f.mimetype, f.buffer]
          );
        }
      }

      const { rows: out } = await pool.query(
        `SELECT l.*,
                COALESCE(json_agg(i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS image_ids
         FROM listings l
         LEFT JOIN images i ON i.listing_id = l.id
         WHERE l.id=$1
         GROUP BY l.id;`,
        [id]
      );
      res.json(out[0]);
    } catch (e) {
      console.error(e);
      res.status(400).json({ error: "Błąd aktualizacji ogłoszenia" });
    }
  }
);

// --- Delete ---
app.delete("/api/listings/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  await pool.query("DELETE FROM listings WHERE id=$1", [id]);
  res.json({ ok: true });
});

// --- Health (dla Railway) ---
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- ROUTING HTML z katalogu głównego ---
// / -> index.html
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
// /oferty.html oraz /panel -> oferty.html (panel osadzony w oferty.html)
app.get(["/oferty.html", "/panel"], (_req, res) => {
  res.sendFile(path.join(__dirname, "oferty.html"));
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on " + PORT));
