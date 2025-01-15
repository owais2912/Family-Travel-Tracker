import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { DB_USER, DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT } = process.env;

if (!DB_USER || !DB_HOST || !DB_NAME || !DB_PASSWORD || !DB_PORT) {
  throw new Error("Missing required database environment variables");
}

const db = new pg.Pool({
  user: DB_USER,
  host: DB_HOST,
  database: DB_NAME,
  password: DB_PASSWORD,
  port: parseInt(DB_PORT, 10),
});

export default db;
