create table sequences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  title text not null,
  content text not null,
  send_at timestamptz not null,
  status text default 'pending' -- pending, sent, failed
);