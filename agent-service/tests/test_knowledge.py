"""A teammate's knowledge base: Vault files read in full, cut into passages, searched with file and page."""
from langchain_core.messages import ToolMessage

from app import knowledge, vault
from tests.conftest import OWNER, ai, settle, teammate


def test_chunks_keep_pages_and_overlap():
    text = "--- page 1 of 2 ---\n" + "Alpha beta. " * 200 + "\n--- page 2 of 2 ---\nPhotosynthesis needs light."
    parts = knowledge.chunks(text)
    assert parts[0][0] == 1 and parts[-1] == (2, "Photosynthesis needs light.")
    assert all(len(b) <= knowledge.CHUNK for _, b in parts)
    assert parts[1][1][:20] in parts[0][1]  # consecutive passages overlap


async def test_a_study_teammate_answers_from_its_notes(api, env, tmp_path, monkeypatch):
    fdb, fake = env
    monkeypatch.setattr(vault, "ROOT", tmp_path, raising=False)
    tutor = teammate(fdb, "tutor", "study buddy")
    folder = await vault.add_folder(OWNER, "Biology")
    await vault.add_bytes(OWNER, "cells.md", b"# Cells\nMitochondria make ATP through cellular respiration.", folder["id"])
    await vault.add_bytes(OWNER, "plants.md", b"Chlorophyll absorbs red and blue light.", folder["id"])

    await knowledge.link(OWNER, tutor["id"], [folder["id"]])
    st = await knowledge.sync(OWNER, tutor["id"])
    assert sorted(f["name"] for f in st["files"].values()) == ["cells.md", "plants.md"]
    assert all(f["chunks"] == 1 for f in st["files"].values())

    seen = {}

    def answer(messages):
        seen["result"] = next(m.content for m in reversed(messages) if isinstance(m, ToolMessage))
        return ai("Mitochondria make ATP (cells.md).")

    fake.script = [ai(calls=[("knowledge", {"query": "mitochondria ATP"})]), answer]
    await api.post(f"/threads/dm:{tutor['id']}/messages", json={"text": "what do mitochondria make?"})
    await settle()
    first = fake.calls[0][0].content
    assert "## Your knowledge base" in first and "cells.md" in first and "Mitochondria make ATP" in first
    assert seen["result"].startswith("[cells.md]") and "cellular respiration" in seen["result"]

    # A new file in the linked folder is picked up; an unlinked folder's files drop out.
    await vault.add_bytes(OWNER, "genes.md", b"DNA is a double helix.", folder["id"])
    st = await knowledge.sync(OWNER, tutor["id"])
    assert len(st["files"]) == 3
    # Unlinking while a read is queued: the queued read must not bring the link back.
    knowledge.sync_later(OWNER, tutor["id"])
    await knowledge.link(OWNER, tutor["id"], [])
    await settle()
    st = await knowledge.sync(OWNER, tutor["id"])
    assert st["links"] == []
    assert st["files"] == {} and await knowledge.search(tutor["id"], "DNA") == []


def test_under_finds_indexed_files_in_a_folder_at_any_depth():
    rows = [{"id": "i", "name": "IITM", "parent": ""}, {"id": "m", "name": "Maths 2", "parent": "i"},
            {"id": "w", "name": "Week 1", "parent": "m"}, {"id": "a", "name": "notes.pdf", "parent": "w"},
            {"id": "b", "name": "rules.md", "parent": "i"}, {"id": "c", "name": "maths 2.pdf", "parent": ""}]
    files = {"a": {}, "b": {}, "c": {}}
    assert knowledge.under(rows, "iitm/maths 2/", files) == ["a"]
    assert sorted(knowledge.under(rows, "IITM", files)) == ["a", "b"]
