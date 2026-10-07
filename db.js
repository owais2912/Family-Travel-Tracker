import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const db = new pg.Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: process.env.DATABASE_SSL === "false" ? false : {
		rejectUnauthorized: false,
	},
});

export default db;
