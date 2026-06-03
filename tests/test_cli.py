from ig_saved_sorter.cli import build_parser, main


def test_list_categories(capsys):
    rc = main(["--list-categories"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "Food & Cooking" in out
    assert "categories" in out


def test_requires_input():
    parser = build_parser()
    # argparse calls SystemExit via parser.error when no input given
    import pytest

    with pytest.raises(SystemExit):
        main([])


def test_missing_clip_dependency_returns_2(tmp_path, capsys):
    # No torch installed in the test env -> graceful exit code 2.
    media = tmp_path / "media"
    media.mkdir()
    (media / "x.jpg").write_bytes(b"data")

    rc = main([str(media), "-o", str(tmp_path / "out")])
    err = capsys.readouterr().err
    assert rc == 2
    assert "torch" in err.lower() or "required" in err.lower()
