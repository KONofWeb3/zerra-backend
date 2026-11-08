import { supabase } from "./supabase";

/**
 * Make a user's display name their X display name, but only when the name on
 * file is still the default one (empty, their Google/sign-up name, or the part
 * of their email before the @). A name someone typed in Settings is left alone.
 */
export async function syncXDisplayName(userId: string, xName: string | null | undefined): Promise<void> {
  const next = xName?.trim();
  if (!next) return;

  const { data: row } = await supabase.from("users").select("name").eq("id", userId).maybeSingle();
  const current = (row?.name ?? "").trim();
  if (current === next) return;

  const { data: auth } = await supabase.auth.admin.getUserById(userId);
  const meta = (auth?.user?.user_metadata ?? {}) as Record<string, string | undefined>;
  const signupNames = [meta.full_name, meta.name, auth?.user?.email?.split("@")[0]]
    .filter((n): n is string => !!n)
    .map((n) => n.trim());

  if (current && !signupNames.includes(current)) return; // they chose this name themselves

  const { error } = await supabase.from("users").update({ name: next }).eq("id", userId);
  if (error) console.error("syncXDisplayName failed:", error.message);
}
