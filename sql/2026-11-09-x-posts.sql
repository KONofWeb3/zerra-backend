-- X posts of connected creators, kept so the Trending page can rank them.
-- Filled by the readiness job (the same fetch that scores each creator).
-- Run in the real Supabase project (fyfwnhwpcdxcscidthst).

create table x_posts (
  post_id    text primary key,                       -- the tweet id
  user_id    uuid not null references users(id) on delete cascade,
  text       text not null default '',
  posted_at  timestamptz not null,
  likes      integer not null default 0,
  replies    integer not null default 0,
  retweets   integer not null default 0,
  quotes     integer not null default 0,
  views      integer not null default 0,
  fetched_at timestamptz not null default now()
);

create index x_posts_user_idx on x_posts (user_id);
create index x_posts_posted_idx on x_posts (posted_at desc);
