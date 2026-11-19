"""Counts the results in JUnit XML files and lists the slowest tests.

Feeds the test-report action: the counts decide whether there is anything to
publish, and the slowest tests go into the job summary, which the JUnit
reporter it uses does not cover.

Usage: report.py <patterns> <slowest.md>
  patterns    newline-separated globs (`**` allowed)
  slowest.md  where to write the markdown table
Writes files, tests, failed and skipped to $GITHUB_OUTPUT.
"""

import glob
import os
import sys
import xml.etree.ElementTree as ET

SLOWEST = 10


def seconds(value):
    try:
        return float(value or 0)
    except ValueError:
        return 0.0


def duration(secs):
    if secs < 1:
        return f"{secs * 1000:.0f}ms"
    if secs < 60:
        return f"{secs:.1f}s"
    return f"{int(secs // 60)}m {secs % 60:.0f}s"


def cell(text):
    return "`" + text.replace("`", "'").replace("|", "\\|").replace("\n", " ") + "`"


def main():
    patterns, slowest_path = sys.argv[1], sys.argv[2]
    files = sorted({f for p in patterns.splitlines() if p.strip() for f in glob.glob(p.strip(), recursive=True)})

    cases = []
    for path in files:
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, OSError) as err:
            print(f"::warning::skipping {path}, which is not readable JUnit: {err}")
            continue
        for case in root.iter("testcase"):
            if case.find("failure") is not None or case.find("error") is not None:
                status = "failed"
            elif case.find("skipped") is not None:
                status = "skipped"
            else:
                status = "passed"
            cases.append((case.get("classname", ""), case.get("name", ""), seconds(case.get("time")), status))

    failed = sum(1 for c in cases if c[3] == "failed")
    skipped = sum(1 for c in cases if c[3] == "skipped")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
        out.write(f"files={len(files)}\ntests={len(cases)}\nfailed={failed}\nskipped={skipped}\n")

    # A Go test's time includes its subtests', so a parent would only repeat
    # its slowest child.
    names = {(c[0], c[1]) for c in cases}
    parents = {(cls, name.rsplit("/", i)[0]) for cls, name in names for i in range(1, name.count("/") + 1)}
    ranked = sorted(
        (c for c in cases if c[3] != "skipped" and c[2] > 0 and (c[0], c[1]) not in parents),
        key=lambda c: c[2],
        reverse=True,
    )[:SLOWEST]
    with open(slowest_path, "w", encoding="utf-8") as out:
        if ranked:
            out.write("<details><summary>Slowest tests</summary>\n\n| Time | Test | Package |\n|---:|---|---|\n")
            for cls, name, secs, _ in ranked:
                out.write(f"| {duration(secs)} | {cell(name)} | {cell(cls)} |\n")
            out.write("\n</details>\n\n")


if __name__ == "__main__":
    main()
