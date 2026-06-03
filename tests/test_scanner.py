from pathlib import Path

from ig_saved_sorter.scanner import is_image, is_video, scan_media


def test_classifies_extensions():
    assert is_image(Path("a.JPG"))
    assert is_image(Path("b.png"))
    assert is_video(Path("c.mp4"))
    assert not is_video(Path("d.jpg"))
    assert not is_image(Path("notes.txt"))


def test_scan_finds_media_recursively(tmp_path):
    (tmp_path / "a.jpg").write_bytes(b"x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.mp4").write_bytes(b"x")
    (tmp_path / "notes.txt").write_bytes(b"x")
    (tmp_path / ".hidden.jpg").write_bytes(b"x")

    found = scan_media(tmp_path)
    names = {p.name for p in found}
    assert names == {"a.jpg", "b.mp4"}


def test_scan_non_recursive(tmp_path):
    (tmp_path / "a.jpg").write_bytes(b"x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.jpg").write_bytes(b"x")

    found = scan_media(tmp_path, recursive=False)
    assert {p.name for p in found} == {"a.jpg"}
