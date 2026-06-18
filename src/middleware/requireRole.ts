// src/middleware/requireRole.ts
import { Request, Response, NextFunction, RequestHandler } from "express";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";

/**
 * Use AFTER requireAuth. Checks the authenticated user's role in the DB
 * and blocks the request if it doesn't match one of the allowed roles.
 */
export function requireRole(...allowedRoles: ("admin" | "project" | "creator")[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = (req as unknown as AuthRequest).user?.id;

    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const { data, error } = await supabase
      .from("users")
      .select("role, account_status")
      .eq("id", userId)
      .single();

    if (error || !data) {
      res.status(403).json({ error: "Could not verify role" });
      return;
    }

    if (data.account_status === "banned") {
      res.status(403).json({ error: "This account has been banned" });
      return;
    }

    if (data.account_status === "restricted") {
      res.status(403).json({ error: "This account is restricted" });
      return;
    }

    if (!allowedRoles.includes(data.role as any)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    next();
  };
}

export const requireAdmin = requireRole("admin");
export const requireProject = requireRole("project", "admin");