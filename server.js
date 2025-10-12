import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import morgan from "morgan";
import helmet from "helmet";
import compression from "compression";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === USTAWIENIA ===
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "listings.json");

// === POMOCNICZE: odczyt/zapis JSON ===
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const seed = [
      {
        id: 1,
        uid: nanoid(8),
        title: "Penthouse Sky Tower",
        city: "Warszawa",
        price: 1200000,
        rooms: 4,
        area: 96,
        type: "Apartament",
        floor: 15,
        garden: false,
        terrace: true,
        image: "https://images.unsplash.com/photo-1523217582562-09d0def993a6?q=80&w=1600&auto=format&fit=crop",
        createdAt: Date.now() - 1000 * 60 * 60 * 24 * 3
      },
      {
        id: 2,
        uid: nanoid(8),
        title: "Apartament Marina",
        city: "Gdańsk",
        price: 890000,
        rooms: 3,
        area: 72,
        type: "Mieszkanie",
        floor: 6,
        garden: false,
        terrace: true,
        image: "https://images.unsplash.com/photo-1505692794403-34d4982f88aa?q=80&w=1600&auto=format&fit=crop",
        createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2
      }
    ];
    fs.writeFileSync(DATA_FILE, JSON.stringify({ seq: 2, items: seed }, null, 2), "utf8");
  }
}

function readData() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  return JSON.parse(raw);
}
function writeData(obj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), "utf8");
}

// === APP ===
const app = express();

// Bezpieczniejsze nagłówki (pozwól na osadzanie iframe Facebook Reels)
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

// Logi + kompresja + JSON body
app.use(morgan("tiny"));
app.use(compression());
app.use(express.json({ limit: "1mb" }));

// === API ===

// Healthcheck
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Pobierz listę ogłoszeń (posortowane najnowsze -> najstarsze)
app.get("/api/listings", (_req, res) => {
  const { items } = readData();
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
  res.json(sorted);
});

// Dodaj ogłoszenie
app.post("/api/listings", (req, res) => {
  const body = req.body || {};
  const required = ["title", "city", "price", "area"];
  for (const key of required) {
    if (
      body[key] === undefined ||
      body[key] === null ||
      String(body[key]).trim() === ""
    ) {
      return res.status(400).json({ error: `Brak pola: ${key}` });
    }
  }

  const data = readData();
  const nextId = (data.seq || 0) + 1;

  const item = {
    id: nextId,
    uid: nanoid(8),
    title: String(body.title).trim(),
    city: String(body.city).trim(),
    price: Number(body.price) || 0,
    rooms: Number(body.rooms) || 1,
    area: Number(body.area) || 0,
    type: body.type ? String(body.type) : "Mieszkanie",
    floor: Number(body.floor) || 0,
    garden: !!body.garden,
    terrace: !!body.terrace,
    image:
      body.image ||
      "https://images.unsplash.com/photo-1528909514045-2fa4ac7a08ba?q=80&w=1600&auto=format&fit=crop",
    createdAt: Date.now()
  };

  data.seq = nextId;
  data.items.unshift(item);
  writeData(data);

  res.status(201).json(item);
});

// Usuń ogłoszenie po id (liczbowym)
app.delete("/api/listings/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Złe id" });

  const data = readData();
  const before = data.items.length;
  data.items = data.items.filter((x) => x.id !== id);
  if (data.items.length === before) {
    return res.status(404).json({ error: "Nie znaleziono" });
  }
  writeData(data);
  res.json({ ok: true });
});

// === STATIC ===
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

// /panel serwuje plik ofert
const offersFile = fs.existsSync(path.join(PUBLIC_DIR, "oferty.html"))
  ? "oferty.html"
  : fs.existsSync(path.join(PUBLIC_DIR, "oferta.html"))
  ? "oferta.html"
  : null;

if (offersFile) {
  app.get("/panel", (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, offersFile))
  );
  // alias ścieżki czytelnej: /oferty
  app.get("/oferty", (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, offersFile))
  );
}

// Fallback – pozwala na „ładne” linki
app.get("*", (req, res, next) => {
  // jeśli żądanie wygląda na asset (ma kropkę w ścieżce), oddaj 404 do next()
  if (path.extname(req.path)) return next();
  // w innym wypadku wracaj na index.html (SPA-like)
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
