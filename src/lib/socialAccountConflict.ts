/**
 * True if a Postgres error is the unique-violation on
 * social_accounts_platform_identity_unique (platform, platform_user_id) -
 * i.e. this exact TikTok/Instagram/X account is already linked to a
 * *different* Zerra user. Distinct from the existing (user_id, platform)
 * conflict, which just means "update this user's own row" and upserts fine.
 */
export function isDuplicateSocialAccountError(error: any): boolean {
  return error?.code === "23505" && String(error?.message ?? "").includes("social_accounts_platform_identity_unique");
}
