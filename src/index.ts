import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { serve } from "inngest/express";
import { supabase } from "./lib/supabase";
import meRouter from "./routes/me";
import authRouter from "./routes/auth";
import bountiesRouter from "./routes/bounties";
import portfolioRouter from "./routes/portfolio";
import analyticsRouter from "./routes/analytics";
import adminRouter from "./routes/admin";
import { inngest } from "./inngest/client";
import { analyzeVideoJob } from "./inngest/functions/analyzeVideo";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", project: "zerra-backend" });
});

// Inngest endpoint — this is what Inngest's servers call to trigger/run jobs.
// Register this exact URL (https://your-render-url.onrender.com/api/inngest)
// in the Inngest dashboard under your app's settings.
app.use(
  "/api/inngest",
  serve({
    client: inngest,
    functions: [analyzeVideoJob],
  })
);

app.use("/me", meRouter);
app.use("/auth", authRouter);
app.use("/bounties", bountiesRouter);
app.use("/portfolio", portfolioRouter);
app.use("/analytics", analyticsRouter);
app.use("/admin", adminRouter);

async function startServer() {
  const { error } = await supabase.from("users").select("id").limit(1);

  if (error) {
    console.error("❌ Supabase connection failed:", error.message);
    process.exit(1);
  }

  console.log("✅ Supabase connected");

  app.listen(PORT, () => {
    console.log(`🚀 Zerra backend running on port ${PORT}`);
    console.log(`⚡ Inngest endpoint live at /api/inngest`);
  });
}

startServer();