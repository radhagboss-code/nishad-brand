const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
const PRICE = 350;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Create/connect a PostgreSQL database in Render and add its connection string to this service.");
  process.exit(1);
}

if (!process.env.ADMIN_SECRET) {
  console.error("ADMIN_SECRET is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function id() {
  return "NB-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function credentialKey() {
  return crypto.createHash("sha256")
    .update(process.env.CREDENTIAL_ENCRYPTION_KEY || process.env.ADMIN_SECRET)
    .digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", credentialKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decrypt(value) {
  const [ivB64, tagB64, dataB64] = String(value).split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", credentialKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_enc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','SOLD')),
      sold_order TEXT,
      sold_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','UNDER_REVIEW','PAID','REJECTED')),
      utr TEXT,
      inventory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS inventory_available_idx ON inventory(status);
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
  `);
  console.log("Database ready");
}

function adminAuth(req, res, next) {
  if (req.get("x-admin-secret") !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/api/health/db", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (e) {
    console.error(e);
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});

app.post("/api/create-order", async (req, res) => {
  try {
    const quantity = Number(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return res.status(400).json({ error: "Invalid quantity" });
    }

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS available FROM inventory WHERE status='AVAILABLE'"
    );
    const available = rows[0].available;
    if (quantity > available) {
      return res.status(400).json({
        error: available === 0 ? "OUT OF STOCK" : `Only ${available} ID(s) available`
      });
    }

    const orderId = id();
    await pool.query(
      `INSERT INTO orders (order_id, quantity, amount, status) VALUES ($1,$2,$3,'PENDING')`,
      [orderId, quantity, quantity * PRICE]
    );
    res.json({ orderId, amount: quantity * PRICE });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to create order" });
  }
});

app.get("/api/stock", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS available FROM inventory WHERE status='AVAILABLE'");
    res.json({ available: rows[0].available });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to load stock" });
  }
});

app.get("/api/order/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM orders WHERE order_id=$1", [req.params.id]);
    const o = rows[0];
    if (!o) return res.status(404).json({ error: "Order not found" });

    let credentials = null;
    if (o.status === "PAID") {
      const ids = Array.isArray(o.inventory_ids) ? o.inventory_ids : [];
      if (ids.length) {
        const r = await pool.query(
          "SELECT id, username, password_enc FROM inventory WHERE id = ANY($1::text[])",
          [ids]
        );
        const byId = new Map(r.rows.map(x => [x.id, x]));
        credentials = ids.map(itemId => {
          const item = byId.get(itemId);
          return item ? { username: item.username, password: decrypt(item.password_enc) } : null;
        }).filter(Boolean);
      } else {
        credentials = [];
      }
    }

    res.json({
      orderId: o.order_id,
      quantity: o.quantity,
      amount: o.amount,
      status: o.status,
      utr: o.utr,
      credentials
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to load order" });
  }
});

app.post("/api/submit-utr", async (req, res) => {
  try {
    const { orderId, utr } = req.body;
    if (typeof utr !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(utr.trim())) {
      return res.status(400).json({ error: "Invalid UTR / Transaction ID" });
    }

    const { rows } = await pool.query("SELECT * FROM orders WHERE order_id=$1", [orderId]);
    const o = rows[0];
    if (!o) return res.status(404).json({ error: "Order not found" });
    if (o.status === "PAID") return res.status(400).json({ error: "Already approved" });

    await pool.query(
      "UPDATE orders SET utr=$1, status='UNDER_REVIEW', updated_at=NOW() WHERE order_id=$2",
      [utr.trim(), orderId]
    );
    res.json({ ok: true, message: "UTR submitted for admin verification" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to submit UTR" });
  }
});

app.get("/api/admin/orders", adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT order_id, quantity, amount, status, utr, created_at FROM orders ORDER BY created_at DESC"
    );
    res.json({ orders: rows.map(o => ({
      orderId: o.order_id,
      quantity: o.quantity,
      amount: o.amount,
      status: o.status,
      utr: o.utr,
      createdAt: o.created_at
    })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to load orders" });
  }
});

app.post("/api/admin/approve", adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderResult = await client.query("SELECT * FROM orders WHERE order_id=$1 FOR UPDATE", [req.body.orderId]);
    const o = orderResult.rows[0];
    if (!o) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }
    if (o.status !== "UNDER_REVIEW") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Order is not under review" });
    }

    const available = await client.query(
      "SELECT id, username, password_enc FROM inventory WHERE status='AVAILABLE' ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1",
      [o.quantity]
    );
    if (available.rows.length < o.quantity) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Not enough IDs in stock" });
    }

    const ids = available.rows.map(x => x.id);
    await client.query(
      "UPDATE inventory SET status='SOLD', sold_order=$1, sold_at=NOW() WHERE id = ANY($2::text[])",
      [o.order_id, ids]
    );
    await client.query(
      "UPDATE orders SET inventory_ids=$1::jsonb, status='PAID', updated_at=NOW() WHERE order_id=$2",
      [JSON.stringify(ids), o.order_id]
    );

    await client.query("COMMIT");
    res.json({ ok: true, message: "Payment approved and IDs assigned" });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(e);
    res.status(500).json({ error: "Unable to approve payment" });
  } finally {
    client.release();
  }
});

app.post("/api/admin/reject", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE orders SET status='REJECTED', updated_at=NOW() WHERE order_id=$1 AND status='UNDER_REVIEW' RETURNING order_id",
      [req.body.orderId]
    );
    if (!result.rowCount) {
      const check = await pool.query("SELECT order_id FROM orders WHERE order_id=$1", [req.body.orderId]);
      if (!check.rowCount) return res.status(404).json({ error: "Order not found" });
      return res.status(400).json({ error: "Order is not under review" });
    }
    res.json({ ok: true, message: "Payment request rejected" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to reject payment" });
  }
});

app.get("/api/admin/inventory", adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, username, status, sold_order, sold_at, created_at FROM inventory ORDER BY created_at DESC"
    );
    const available = rows.filter(x => x.status === "AVAILABLE").length;
    res.json({
      available,
      sold: rows.length - available,
      total: rows.length,
      items: rows.map(x => ({
        id: x.id,
        username: x.username,
        status: x.status,
        soldOrder: x.sold_order || null,
        soldAt: x.sold_at || null
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to load inventory" });
  }
});

app.post("/api/admin/inventory/add", adminAuth, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });

    await pool.query(
      "INSERT INTO inventory (id, username, password_enc) VALUES ($1,$2,$3)",
      [id(), username, encrypt(password)]
    );
    res.json({ ok: true, message: "ID added" });
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "Username already exists" });
    console.error(e);
    res.status(500).json({ error: "Unable to add ID" });
  }
});

app.post("/api/admin/inventory/delete", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM inventory WHERE id=$1 AND status='AVAILABLE' RETURNING id",
      [req.body.id]
    );
    if (result.rowCount) return res.json({ ok: true, message: "ID deleted" });

    const check = await pool.query("SELECT status FROM inventory WHERE id=$1", [req.body.id]);
    if (!check.rowCount) return res.status(404).json({ error: "ID not found" });
    return res.status(400).json({ error: "Sold ID cannot be deleted" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to delete ID" });
  }
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`NISHAD BRAND running on port ${PORT}`)))
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
