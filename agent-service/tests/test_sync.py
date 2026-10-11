import pytest

from app import computers, sync, vault

U = "00000000-0000-0000-0000-0000000000aa"


async def test_a_synced_folder_follows_its_computer(env, tmp_path, monkeypatch):
    monkeypatch.setattr(vault, "ROOT", tmp_path)
    disk = {"notes.md": b"# hi", "week 1/a.pdf": b"%PDF-1", "week 1/deep/b.txt": b"b"}
    mtimes = {k: 1 for k in disk}

    async def call(cid, op, args, timeout_s=0):
        assert cid == "laptop" and args["path"] == "/home/me/Uni"
        if op == "sync_scan":
            return [[k, len(v), mtimes[k]] for k, v in disk.items()]
        for rel in args["files"]:  # the runner sends each file, here in two pieces
            data = disk[rel]
            await sync.receive(U, "laptop", args["sid"], rel, mtimes[rel], 0, False, data[:1])
            await sync.receive(U, "laptop", args["sid"], rel, mtimes[rel], 1, True, data[1:])
        return {"sent": len(args["files"]), "failed": []}

    async def listing(owner):
        return [{"id": "laptop", "name": "Akhil's laptop"}]

    monkeypatch.setattr(computers, "call", call)
    monkeypatch.setattr(computers, "listing", listing)
    root = await vault.add_folder(U, "Uni", meta={"source": {"computer": "laptop", "name": "Akhil's laptop", "path": "/home/me/Uni"}})

    def files():
        return {r["meta"]["rel"]: r for r in sync._tree(rows, root["id"]) if r["kind"] == "file"}

    assert (await sync.sync_root(U, root))["added"] == 3
    rows = await vault.items(U)
    assert set(files()) == set(disk) and vault.read_bytes(U, files()["week 1/deep/b.txt"]["id"]) == b"b"
    with pytest.raises(ValueError):  # the computer owns its copies
        await vault.remove(U, files()["notes.md"]["id"])

    del disk["week 1/a.pdf"], disk["week 1/deep/b.txt"]
    disk["notes.md"], mtimes["notes.md"] = b"# changed", 2
    got = await sync.sync_root(U, root)
    rows = await vault.items(U)
    assert got["added"] == 1 and set(files()) == {"notes.md"}
    assert vault.read_bytes(U, files()["notes.md"]["id"]) == b"# changed"
    assert not [r for r in sync._tree(rows, root["id"]) if r["kind"] == "folder"]  # "week 1" went with its files
    assert (await sync.sync_root(U, root))["added"] == 0  # nothing new: nothing sent

    with pytest.raises(PermissionError):
        await sync.receive(U, "other-computer", root["id"], "x.txt", 1, 0, True, b"x")
