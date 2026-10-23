-- Sign-in cards: a teammate needs the user signed in to a site in Tubelight's browser (agent-service browser.py).
-- Same pause/resume path as question and connect cards.
alter table public.approvals drop constraint if exists approvals_kind_check;
alter table public.approvals add constraint approvals_kind_check
  check (kind in ('approval', 'question', 'connect', 'signin'));
alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'approval', 'handoff', 'error', 'event', 'question', 'connect', 'signin'));
