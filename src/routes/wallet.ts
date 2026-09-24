// src/routes/wallet.ts
//
// Self-serve withdrawals. Replaces the old model (creator sets an address,
// Zerra's team manually sends funds and records an `earnings` row) with a
// balance the creator draws down themselves - but only for claims verified
// going forward; nothing here touches how a claim gets approved, which is
// still a manual review step done elsewhere.
//
// Ledger, no per-claim status flipping on withdrawal (see sql/2026-09-23-withdrawals.sql
// for the full reasoning):
//
//   approved_total  = sum(reward_usdc) for this user's claims with status
//                      IN ('approved', 'paid') - both count as "verified,
//                      reward earned", regardless of which system paid it out.
//   already_sent    = sum(earnings.amount_usdc)                    -- old manual payouts
//                    + sum(withdrawals.amount_usdc where status IN ('pending','completed'))
//   available       = approved_total - already_sent, floored at 0
//   pending_rewards = sum(reward_usdc) for claims with status IN ('pending','submitted')
//   lifetime_earned = approved_total

import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";
import { isTreasuryConfigured, getTreasuryBalanceUsdc, sendUsdc, TreasuryNotConfiguredError } from "../lib/treasury";

const router = Router();

// Flat fee, covers the real Base network gas the treasury wallet pays to send
// the transfer (paid in ETH, not USDC - this is what converts that into a
// simple flat USDC amount instead of a live gas estimate). Deducted from the
// requested amount, not added on top: a 500 USDC withdrawal request reduces
// the balance by 500 and sends 499.90 on-chain. Exported so the balance route
// can tell the frontend what "You receive" will actually be for a given amount.
export const WITHDRAWAL_FEE_USDC = 0.10;

interface Balance {
  available_to_withdraw: number;
  pending_rewards: number;
  lifetime_earned: number;
  this_month_usdc: number;
}

async function computeBalance(userId: string): Promise<Balance> {
  const [{ data: claims, error: claimsError }, { data: earnings, error: earningsError }, { data: withdrawals, error: withdrawalsError }] =
    await Promise.all([
      supabase.from("claims").select("status, submitted_at, bounties ( reward_usdc )").eq("user_id", userId),
      supabase.from("earnings").select("amount_usdc"),
      supabase.from("withdrawals").select("amount_usdc, status").eq("user_id", userId).in("status", ["pending", "completed"]),
    ]);

  if (claimsError) throw claimsError;
  if (earningsError) throw earningsError;
  if (withdrawalsError) throw withdrawalsError;

  const rewardOf = (c: any) => Number(c.bounties?.reward_usdc ?? 0);

  const approvedTotal = (claims ?? [])
    .filter((c) => c.status === "approved" || c.status === "paid")
    .reduce((sum, c) => sum + rewardOf(c), 0);

  const pendingRewards = (claims ?? [])
    .filter((c) => c.status === "pending" || c.status === "submitted")
    .reduce((sum, c) => sum + rewardOf(c), 0);

  const alreadySentViaEarnings = (earnings ?? []).reduce((sum, e) => sum + Number(e.amount_usdc ?? 0), 0);
  const alreadySentViaWithdrawals = (withdrawals ?? []).reduce((sum, w) => sum + Number(w.amount_usdc ?? 0), 0);

  const available = Math.max(0, approvedTotal - alreadySentViaEarnings - alreadySentViaWithdrawals);

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const thisMonth = (claims ?? [])
    .filter((c) => (c.status === "approved" || c.status === "paid") && c.submitted_at && new Date(c.submitted_at) >= startOfMonth)
    .reduce((sum, c) => sum + rewardOf(c), 0);

  return {
    available_to_withdraw: Math.round(available * 100) / 100,
    pending_rewards: Math.round(pendingRewards * 100) / 100,
    lifetime_earned: Math.round(approvedTotal * 100) / 100,
    this_month_usdc: Math.round(thisMonth * 100) / 100,
  };
}

// GET /wallet/balance
router.get("/balance", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  try {
    res.json({
      balance: await computeBalance(user.id),
      treasuryConfigured: isTreasuryConfigured(),
      withdrawalFeeUsdc: WITHDRAWAL_FEE_USDC,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /wallet/transactions — rewards (from claims) and withdrawals, merged and sorted.
// Same two real sources the old Portfolio page already reads; nothing invented here.
router.get("/transactions", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  const [{ data: claims, error: claimsError }, { data: withdrawals, error: withdrawalsError }] = await Promise.all([
    supabase.from("claims")
      .select("id, status, submitted_at, bounties ( project_name, reward_usdc )")
      .eq("user_id", user.id)
      .in("status", ["approved", "paid"])
      .order("submitted_at", { ascending: false }),
    supabase.from("withdrawals")
      .select("id, amount_usdc, status, tx_hash, network, created_at, completed_at, error")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
  ]);

  if (claimsError) { res.status(500).json({ error: claimsError.message }); return; }
  if (withdrawalsError) { res.status(500).json({ error: withdrawalsError.message }); return; }

  const rewardTxs = (claims ?? []).map((c: any) => ({
    type: "reward" as const,
    id: c.id,
    label: c.bounties?.project_name ?? "Campaign reward",
    amount_usdc: Number(c.bounties?.reward_usdc ?? 0),
    status: "completed" as const,
    date: c.submitted_at,
  }));

  const withdrawalTxs = (withdrawals ?? []).map((w) => ({
    type: "withdrawal" as const,
    id: w.id,
    label: "Wallet withdrawal",
    amount_usdc: -Number(w.amount_usdc),
    status: w.status as "pending" | "completed" | "failed",
    tx_hash: w.tx_hash,
    network: w.network,
    error: w.error,
    date: w.completed_at ?? w.created_at,
  }));

  const transactions = [...rewardTxs, ...withdrawalTxs].sort(
    (a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime()
  );

  res.json({ transactions });
});

// POST /wallet/withdraw { amount_usdc }
// Sends to the address already saved via PUT /me/wallet — no destination is
// ever taken from the request body, so this endpoint can't be used to redirect
// funds to an address the creator didn't already set up as their own.
router.post("/withdraw", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const amount = Number(req.body.amount_usdc);

  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "amount_usdc must be a positive number" });
    return;
  }
  if (amount <= WITHDRAWAL_FEE_USDC) {
    res.status(400).json({ error: `Amount must be more than the ${WITHDRAWAL_FEE_USDC} USDC network fee.` });
    return;
  }

  if (!isTreasuryConfigured()) {
    res.status(503).json({ error: "Withdrawals aren't turned on yet. Check back soon." });
    return;
  }

  const { data: userRow, error: userError } = await supabase
    .from("users").select("wallet_address, wallet_chain").eq("id", user.id).single();
  if (userError || !userRow?.wallet_address) {
    res.status(400).json({ error: "Connect a wallet in Settings before withdrawing." });
    return;
  }
  if ((userRow.wallet_chain ?? "ethereum") !== "base") {
    res.status(400).json({ error: "Withdrawals currently only support a Base wallet address. Update your wallet network in Settings." });
    return;
  }

  // Claim the withdrawal slot with an insert BEFORE sending anything - a concurrent
  // second request finds the existing 'pending' row and is rejected, rather than
  // both requests racing to check the balance and double-spending it.
  const { data: existingPending } = await supabase
    .from("withdrawals").select("id").eq("user_id", user.id).eq("status", "pending").limit(1);
  if (existingPending && existingPending.length > 0) {
    res.status(409).json({ error: "A withdrawal is already in progress." });
    return;
  }

  let balance: Balance;
  try {
    balance = await computeBalance(user.id);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }
  if (amount > balance.available_to_withdraw) {
    res.status(400).json({ error: `Amount exceeds available balance (${balance.available_to_withdraw} USDC).` });
    return;
  }

  // amount_usdc stays the gross, requested amount - that's what the balance
  // ledger deducts (computeBalance sums this column), matching "withdrawing
  // 500 reduces your available balance by 500". network_fee_usdc records what
  // Zerra keeps; only amount - fee is ever actually sent on-chain, below.
  const netAmount = Math.round((amount - WITHDRAWAL_FEE_USDC) * 1e6) / 1e6;

  const { data: withdrawal, error: insertError } = await supabase
    .from("withdrawals")
    .insert({
      user_id: user.id, amount_usdc: amount, network_fee_usdc: WITHDRAWAL_FEE_USDC,
      destination_address: userRow.wallet_address, network: "base", status: "pending",
    })
    .select().single();
  if (insertError || !withdrawal) {
    // 23505 = unique_violation on withdrawals_one_pending_per_user - the real,
    // database-enforced version of the "existingPending" check above. That
    // check has its own race window; this is what actually closes it.
    if (insertError?.code === "23505") {
      res.status(409).json({ error: "A withdrawal is already in progress." });
      return;
    }
    res.status(500).json({ error: insertError?.message ?? "Failed to start withdrawal" });
    return;
  }

  try {
    const treasuryBalance = await getTreasuryBalanceUsdc();
    if (treasuryBalance < netAmount) {
      throw new Error("Treasury balance is temporarily insufficient. Try again shortly, or contact support.");
    }

    const { txHash } = await sendUsdc(userRow.wallet_address, netAmount);

    await supabase.from("withdrawals")
      .update({ status: "completed", tx_hash: txHash, completed_at: new Date().toISOString() })
      .eq("id", withdrawal.id);

    res.json({ status: "completed", tx_hash: txHash, amount_usdc: amount, net_amount_usdc: netAmount });
  } catch (err: any) {
    const message = err instanceof TreasuryNotConfiguredError ? err.message : (err.message ?? "Withdrawal failed");
    await supabase.from("withdrawals").update({ status: "failed", error: message }).eq("id", withdrawal.id);
    res.status(502).json({ error: message });
  }
});

export default router;
