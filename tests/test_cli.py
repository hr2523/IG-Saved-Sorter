import pytest

from ig_saved_sorter.cli import build_parser, main


def test_list_categories_flag(capsys):
    rc = main(["--list-categories"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "Food & Cooking" in out
    assert "categories" in out


def test_categories_subcommand(capsys):
    rc = main(["categories"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "Food & Cooking" in out


def test_no_subcommand_errors():
    with pytest.raises(SystemExit):
        main([])


def test_sort_missing_clip_dependency_returns_2(tmp_path, capsys):
    # No torch installed in the test env -> graceful exit code 2.
    media = tmp_path / "media"
    media.mkdir()
    (media / "x.jpg").write_bytes(b"data")

    rc = main(["sort", str(media), "-o", str(tmp_path / "out")])
    err = capsys.readouterr().err
    assert rc == 2
    assert "torch" in err.lower() or "required" in err.lower()


def test_sort_empty_folder_returns_1(tmp_path, capsys):
    media = tmp_path / "media"
    media.mkdir()
    rc = main(["sort", str(media)])
    assert rc == 1


def test_sync_requires_user():
    with pytest.raises(SystemExit):
        main(["sync"])


def test_sync_missing_instagrapi_returns_2(tmp_path, capsys):
    # instagrapi not installed -> FetcherError -> exit code 2.
    rc = main(["sync", "-u", "someone", "--media-dir", str(tmp_path / "m")])
    err = capsys.readouterr().err
    assert rc == 2
    assert "instagrapi" in err.lower()
