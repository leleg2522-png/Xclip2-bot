import { defineConfig } from "drizzle-kit";
import path from "path";

const dbUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;

if (!dbUrl) {
  throw new Error("RAILWAY_DATABASE_URL must be set. Please add your Railway database connection string.");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
  },
});
