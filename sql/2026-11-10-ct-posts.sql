-- Top posts on Crypto Twitter, collected every few hours for the Trending page.
-- Not tied to Zerra users: these are the most-viewed posts on CT topics in the last day or two.
-- Run in the real Supabase project (fyfwnhwpcdxcscidthst).

create table ct_posts (
  post_id    text primary key,                 -- the tweet id
  text       text not null default '',
  posted_at  timestamptz not null,
  likes      bigint not null default 0,
  replies    bigint not null default 0,
  retweets   bigint not null default 0,
  quotes     bigint not null default 0,
  views      bigint not null default 0,
  handle     text not null,                    -- author @handle, without the @
  name       text,
  avatar     text,
  followers  bigint,
  fetched_at timestamptz not null default now()
);

create index ct_posts_posted_idx on ct_posts (posted_at desc);
create index ct_posts_views_idx on ct_posts (views desc);
