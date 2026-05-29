import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";

const router = Router();

// GET /me — returns the current logged in user
router.get("/", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ user: data });
});

export default router;