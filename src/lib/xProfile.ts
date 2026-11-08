import { supabase } from "./supabase";

/** X serves a 48px thumbnail by default (…_normal.jpg); the same image is available at 400x400. */
function bigAvatar(url: string): string {
  return url.replace(/_normal(\.\w+)$/, "_400x400$1");
}

/**
 * Make a user's name and profile picture their X display name and X picture,
 * but only where what's on file is still a default: empty, or what they signed
 * up with (their Google name/photo, or the part of their email before the @).
 * Anything they set themselves in Settings is left alone.
 */
export async function syncXProfile(
  userId: string,
  x: { name?: string | null; avatar?: string | null },
): Promise<void> {
  const nextName = x.name?.trim() || null;
  const nextAvatar = x.avatar ? bigAvatar(x.avatar.trim()) : null;
  if (!nextName && !nextAvatar) return;

  const { data: row } = await supabase.from("users").select("name, avatar").eq("id", userId).maybeSingle();
  const { data: auth } = await supabase.auth.admin.getUserById(userId);
  const meta = (auth?.user?.user_metadata ?? {}) as Record<string, string | undefined>;

  const update: { name?: string; avatar?: string } = {};

  if (nextName) {
    const current = (row?.name ?? "").trim();
    const signupNames = [meta.full_name, meta.name, auth?.user?.email?.split("@")[0]]
      .filter((n): n is string => !!n)
      .map((n) => n.trim());
    if (current !== nextName && (!current || signupNames.includes(current))) update.name = nextName;
  }

  if (nextAvatar) {
    const current = (row?.avatar ?? "").trim();
    const signupAvatars = [meta.avatar_url, meta.picture].filter((u): u is string => !!u);
    if (current !== nextAvatar && (!current || signupAvatars.includes(current))) update.avatar = nextAvatar;
  }

  if (Object.keys(update).length === 0) return;
  const { error } = await supabase.from("users").update(update).eq("id", userId);
  if (error) console.error("syncXProfile failed:", error.message);
}
