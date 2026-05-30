import { Request, Response, NextFunction } from "express";
import { supabase } from "../lib/supabase";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  
  // Accept token from header OR query param (needed for OAuth redirects)
  const token =
    (authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null) || (req.query.token as string);

  if (!token) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  (req as any).user = data.user;
  next();
}