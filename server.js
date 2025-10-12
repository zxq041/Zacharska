const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ── statyki z katalogu głównego repo (bo index.html i oferty.html są w root)
app.use(express.static(__dirname, { extensions: ["html"] }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ── prosty "dysk" na ogłoszenia
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "listings.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(DB_FILE))
  fs.writeFileSync(DB_FILE, JSON.stringify({ items: [] }, null, 2), "utf8");

// ── strony
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get(["/oferty", "/oferty.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "oferty.html"));
});

app.get("/panel", (_req, res) => {
  const adminFile = path.join(__dirname, "panel.html");
  // jeśli nie masz jeszcze panel.html – pokaż listę ofert z formularzem (oferty.html)
  res.sendFile(fs.existsSync(adminFile) ? adminFile : path.join(__dirname, "oferty.html"));
});

// ── API
app.get("/api/listings", (_req, res) => {
  try {
    const { items } = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    // najnowsze najpierw
    const sorted = [...items].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    res.json(sorted);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "READ_FAILED" });
  }
});

app.post("/api/listings", (req, res) => {
  const p = req.body || {};
  // podstawowe pola – dopasuj do formularza na froncie
  if (!p.title || !p.city || !p.price) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }
  const item = {
    id: Math.random().toString(36).slice(2),
    title: p.title,
    city: p.city,
    price: Number(p.price),
    rooms: Number(p.rooms || 0),
    area: Number(p.area || 0),
    type: p.type || "Mieszkanie",
    floor: Number(p.floor || 0),
    terrace: Boolean(p.terrace),
    garden: Boolean(p.garden),
    image: p.image || "https://images.unsplash.com/photo-1505691723518-36a5ac3b2d51?q=80&w=1600&auto=format&fit=crop",
    createdAt: new Date().toISOString(),
    // dowolne dodatkowe pola:
    description: p.description || ""
  };

  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    db.items.unshift(item); // najnowsze na górze
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
    res.status(201).json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "WRITE_FAILED" });
  }
});

app.delete("/api/listings/:id", (req, res) => {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    const idx = db.items.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "NOT_FOUND" });
    const [removed] = db.items.splice(idx, 1);
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
    res.json(removed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DELETE_FAILED" });
  }
});

// ── fallback (dla innych ścieżek zwróć 404 lub index, tu 404)
app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
});
