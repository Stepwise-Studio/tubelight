-- A group chat's picture: one of the app's GROUP_ICONS (components/thread-avatar.tsx) on the project colour.
alter table public.projects add column if not exists icon text;
