-- A teammate can have several chats: the main one 'dm:<teammate_id>' plus extra ones 'dm:<teammate_id>:<id>'
-- (made by the app; the inbox shows one row per teammate). The keeper names the extra ones.
alter table public.threads add column if not exists title text;
