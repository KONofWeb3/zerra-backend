import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { supabase } from "./lib/supabase";
import meRouter from "./routes/me";
import authRouter from "./routes/auth";
import bountiesRouter from "./routes/bounties";
import portfolioRouter from "./routes/portfolio";
import analyticsRouter from "./routes/analytics";
import adminRouter from "./routes/admin";
import projectRouter from "./routes/project";
import { startVerificationWorker } from "./jobs/verificationWorker";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());

// Accepts both the www and non-www version of the domain (plus the old
// demo subdomain, kept alive for old links). www.zerra.pro and zerra.pro
// are different CORS origins to the browser even though they're the same
// site to a human — this is what broke every authenticated request after
// the domain migration.
const ALLOWED_ORIGINS = [
  "https://zerra.pro",
  "https://www.zerra.pro",
  "https://demo.zerra.pro",
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, Postman, etc.)
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`CORS blocked request from origin: ${origin}`);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", project: "zerra-backend" });
});

app.use("/me", meRouter);
app.use("/auth", authRouter);
app.use("/bounties", bountiesRouter);
app.use("/portfolio", portfolioRouter);
app.use("/analytics", analyticsRouter);
app.use("/admin", adminRouter);
app.use("/project", projectRouter);

async function startServer() {
  const { error } = await supabase.from("users").select("id").limit(1);

  if (error) {
    console.error("❌ Supabase connection failed:", error.message);
    process.exit(1);
  }

  console.log("✅ Supabase connected");

  app.listen(PORT, () => {
    console.log(`🚀 Zerra backend running on port ${PORT}`);
  });

  // Start the in-process verification worker — replaces Inngest entirely.
  // Polls video_analysis for 'pending' rows every 30s and processes them.
  startVerificationWorker();
}

startServer();