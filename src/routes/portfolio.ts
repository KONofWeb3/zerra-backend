import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";

const router = Router();

// GET /portfolio/earnings — full earnings history for logged in user
router.get("/earnings", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  const { data, error } = await supabase
    .from("earnings")
    .select(`
      *,
      claims (
        status,
        submitted_at,
        bounties (
          project_name,
          token_icon,
          reward_usdc
        )
      )
    `)
    .eq("user_id", user.id)
    .order("paid_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ earnings: data });
});

// GET /portfolio/stats — totals and summary for logged in user
router.get("/stats", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  // Total earned
  const { data: earningsData, error: earningsError } = await supabase
    .from("earnings")
    .select("amount_usdc")
    .eq("user_id", user.id);

  if (earningsError) {
    res.status(500).json({ error: earningsError.message });
    return;
  }

  const totalEarned = earningsData.reduce(
    (sum, e) => sum + Number(e.amount_usdc),
    0
  );

  // This month earnings
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data: thisMonthData, error: thisMonthError } = await supabase
    .from("earnings")
    .select("amount_usdc")
    .eq("user_id", user.id)
    .gte("paid_at", startOfMonth.toISOString());

  if (thisMonthError) {
    res.status(500).json({ error: thisMonthError.message });
    return;
  }

  const thisMonth = thisMonthData.reduce(
    (sum, e) => sum + Number(e.amount_usdc),
    0
  );

  // Claims summary
  const { data: claimsData, error: claimsError } = await supabase
    .from("claims")
    .select("status")
    .eq("user_id", user.id);

  if (claimsError) {
    res.status(500).json({ error: claimsError.message });
    return;
  }

  const claimsSummary = claimsData.reduce(
    (acc, c) => {
      acc[c.status] = (acc[c.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  res.json({
    stats: {
      total_earned_usdc: totalEarned,
      this_month_usdc: thisMonth,
      claims: {
        total: claimsData.length,
        pending: claimsSummary["pending"] || 0,
        submitted: claimsSummary["submitted"] || 0,
        approved: claimsSummary["approved"] || 0,
        paid: claimsSummary["paid"] || 0,
      },
    },
  });
});

// GET /portfolio/claims — all claims for logged in user
router.get("/claims", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  const { data, error } = await supabase
    .from("claims")
    .select(`
      *,
      bounties (
        project_name,
        token_icon,
        reward_usdc,
        description
      )
    `)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ claims: data });
});

export default router;