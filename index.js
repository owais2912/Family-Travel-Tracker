import express from "express";
import db from "./db.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createHash, createHmac, timingSafeEqual } from "crypto";

dotenv.config();

const app = express();
const port = process.env.APP_PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const colors = new Set(["red", "green", "yellow", "olive", "orange", "teal", "blue", "violet", "purple", "pink", "powderblue", "indigo"]);
const editPasscode = process.env.TRAVEL_EDIT_PASSCODE;

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function selectedUserId(req) {
  const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("travel_user="));
  return cookie ? Number(cookie.split("=")[1]) : null;
}

function canEdit(req) {
  if (!editPasscode) return false;
  const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("travel_edit="));
  const token = cookie?.split("=")[1] || "";
  const expected = createHmac("sha256", editPasscode).update("family-travel-edit-v1").digest("hex");
  return /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
}

function requireEdit(req, res, next) {
  if (canEdit(req)) return next();
  res.redirect("/?error=" + encodeURIComponent("Unlock editing with the family passcode first."));
}

function selectUser(res, id) {
  res.cookie("travel_user", String(id), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
}

async function getFamily(req) {
  const { rows: users } = await db.query("SELECT id, name, color FROM users ORDER BY id");
  const currentUser = users.find((user) => user.id === selectedUserId(req)) || users[0] || null;
  return { users, currentUser };
}

app.get("/", async (req, res, next) => {
  try {
    const { users, currentUser } = await getFamily(req);
    const { rows: visitedCountries } = currentUser
      ? await db.query(
          "SELECT v.country_code, c.country_name FROM visited_countries v JOIN countries c ON c.country_code = v.country_code WHERE v.user_id = $1 ORDER BY c.country_name",
          [currentUser.id]
        )
      : { rows: [] };
    const visitedCodes = visitedCountries.map((country) => country.country_code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));
    res.render("index.ejs", {
      users,
      currentUser,
      visitedCountries,
      visitedCodes,
      color: colors.has(currentUser?.color) ? currentUser.color : "teal",
      error: req.query.error || "",
      canEdit: canEdit(req),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/unlock", (req, res) => {
  const supplied = String(req.body.passcode || "");
  if (!editPasscode || !timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(editPasscode || "").digest()
  )) {
    return res.redirect("/?error=" + encodeURIComponent("Incorrect family passcode."));
  }
  const token = createHmac("sha256", editPasscode).update("family-travel-edit-v1").digest("hex");
  res.cookie("travel_edit", token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.redirect("/");
});

app.post("/lock", (req, res) => {
  res.clearCookie("travel_edit");
  res.redirect("/");
});

app.post("/user", async (req, res, next) => {
  try {
    const id = Number(req.body.user);
    if (!Number.isInteger(id)) return res.redirect("/");
    const { rows } = await db.query("SELECT id FROM users WHERE id = $1", [id]);
    if (rows.length) selectUser(res, id);
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.post("/new", requireEdit, async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const color = String(req.body.color || "");
    if (!name || name.length > 80 || !colors.has(color)) {
      return res.redirect("/?error=" + encodeURIComponent("Enter a name and choose a color."));
    }
    const { rows } = await db.query("INSERT INTO users (name, color) VALUES ($1, $2) RETURNING id", [name, color]);
    selectUser(res, rows[0].id);
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.post("/add", requireEdit, async (req, res, next) => {
  try {
    const { currentUser } = await getFamily(req);
    if (!currentUser) return res.redirect("/?error=" + encodeURIComponent("Add a family member first."));
    const input = String(req.body.country || "").trim();
    if (!input) return res.redirect("/?error=" + encodeURIComponent("Enter a country name."));
    const { rows } = await db.query(
      "SELECT country_code, LOWER(country_name) = LOWER($1) AS exact FROM countries WHERE LOWER(country_name) = LOWER($1) OR LOWER(country_name) LIKE LOWER($1) || '%' ORDER BY exact DESC, country_name LIMIT 2",
      [input]
    );
    if (!rows.length || (rows.length > 1 && !rows[0].exact)) {
      return res.redirect("/?error=" + encodeURIComponent(rows.length ? "Use a more specific country name." : "Country not found."));
    }
    await db.query(
      "INSERT INTO visited_countries (country_code, user_id) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM visited_countries WHERE country_code = $1 AND user_id = $2)",
      [rows[0].country_code, currentUser.id]
    );
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.post("/remove-country", requireEdit, async (req, res, next) => {
  try {
    const { currentUser } = await getFamily(req);
    const code = String(req.body.countryCode || "").trim().toUpperCase();
    if (currentUser && /^[A-Z]{2}$/.test(code)) {
      await db.query("DELETE FROM visited_countries WHERE user_id = $1 AND country_code = $2", [currentUser.id, code]);
    }
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.post("/delete-user", requireEdit, async (req, res, next) => {
  const id = Number(req.body.userId);
  if (!Number.isInteger(id)) return res.redirect("/");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM visited_countries WHERE user_id = $1", [id]);
    await client.query("DELETE FROM users WHERE id = $1", [id]);
    await client.query("COMMIT");
    if (selectedUserId(req) === id) res.clearCookie("travel_user");
    res.redirect("/");
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
