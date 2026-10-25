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
    assert "Mail that may need them (2)" in out and "Sat Oct 24 03:00 PM · Asha <a@x.com> · Hi — Can we meet Tuesday?" in out
    assert "cv.pdf (attachment_id A1)" in out and "(message_id id1)" in out and "OTP" in out
    assert "Promotions (4): Rapido ×4 (Deal 2)" in out


def test_hidden_replies_never_reach_the_model_again():
    tm = {"handle": "ivy", "name": "Ivy", "role": "Inbox"}
    msgs = [HumanMessage("check mail"), AIMessage("QUIET", name="ivy"), HumanMessage("hello"),
            AIMessage("Pass the details to Tempo.", name="ivy")]
    assert [x.content for x in graph.view_for(tm, msgs, [tm])] == ["check mail", "hello", "Pass the details to Tempo."]
