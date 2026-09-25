-- Things a teammate waits on besides approvals: a question with options, or an app to connect.
-- They share the approvals table (same pause/resume path); the Approvals tab shows kind = 'approval' only.
alter table public.approvals
  add column kind text not null default 'approval' check (kind in ('approval', 'question', 'connect')),
  add column answer text;

alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'approval', 'handoff', 'error', 'event', 'question', 'connect'));

-- Swipe to reply.
alter table public.messages add column reply_to uuid references public.messages on delete set null;

-- Attachments: private bucket, one folder per user (<owner_id>/<uuid>-<name>). Metadata lives in messages.meta.attachments.
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 26214400)
on conflict (id) do nothing;

create policy attachments_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy attachments_owner_write on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy attachments_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
