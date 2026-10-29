from langchain_core.messages import AIMessage, HumanMessage

from app import graph, mail


def m(i, labels, sender="Asha <a@x.com>", subject="Hi", att=None):
    return {"messageId": f"id{i}", "labelIds": str(labels), "sender": sender, "subject": subject,
            "messageTimestamp": "2026-10-24T09:30:00Z", "preview": "{'body': 'Can we meet Tuesday?', 'subject': 'Hi'}",
            "attachmentList": att or []}


def test_digest_lists_real_mail_and_folds_the_noise():
    mails = [m(1, ["UNREAD", "INBOX", "IMPORTANT"], att=[{"filename": "cv.pdf", "attachmentId": "A1"}]),
             *[m(i, ["CATEGORY_PROMOTIONS", "INBOX"], "Rapido <r@x>", f"Deal {i}") for i in range(2, 6)],
             m(9, ["CATEGORY_UPDATES", "IMPORTANT"], "Bank <b@x>", "OTP")]
    out = mail.digest(mails, "Asia/Kolkata", "in the last 7 days")
    assert out.startswith("6 emails in the last 7 days (1 unread).")
    assert "People and services, not promotions/social/updates (2)" in out and "Sat Oct 24 03:00 PM · Asha <a@x.com> · Hi — Can we meet Tuesday?" in out
    assert "[1 attachments: cv.pdf]" in out and "A1" not in out and "(message_id id1)" in out and "OTP" in out
    assert "Promotions (4): Rapido ×4 (Deal 2)" in out


def test_hidden_replies_never_reach_the_model_again():
    tm = {"handle": "ivy", "name": "Ivy", "role": "Inbox"}
    msgs = [HumanMessage("check mail"), AIMessage("QUIET", name="ivy"), HumanMessage("hello"),
            AIMessage("Pass the details to Tempo.", name="ivy")]
    assert [x.content for x in graph.view_for(tm, msgs, [tm])] == ["check mail", "hello", "Pass the details to Tempo."]


def test_a_stack_from_one_sender_reads_as_one_batch():
    hr = [m(i, ["INBOX", "UNREAD"], "HR <hr@acme.com>", f"Fw: Application – {n}") for i, n in enumerate(["Asha", "Ravi", "Meera"])]
    out = mail.digest([*hr, m(7, ["INBOX"])], "Asia/Kolkata", "this week")
    assert "BATCH: 3 emails from HR <hr@acme.com>" in out and "Fw: Application – Ravi" in out
    assert "message_ids id0, id1, id2" in out and out.count("· Asha <a@x.com> ·") == 1


def test_the_one_mail_with_fifteen_resumes_stands_out_of_its_batch():
    cvs = [{"filename": f"{i}.pdf", "attachmentId": "x" * 400} for i in range(15)]
    hr = [m(i, ["INBOX"], "HR <hr@mxc.com>", f"Fw: Application {i}", att=[cvs[0]]) for i in range(37)]
    hr.append(m(99, ["INBOX"], "HR <hr@mxc.com>", "Junior AI Engineer profiles : 2-3 years", att=cvs))
    out = mail.digest(hr, "Asia/Kolkata", "this month")
    assert "Junior AI Engineer profiles : 2-3 years — 15 attachments (message_id id99)" in out and "x" * 400 not in out
