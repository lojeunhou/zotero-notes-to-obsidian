#!/usr/bin/env python3
"""Sync local Zotero notes into an Obsidian vault as Markdown."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "http://127.0.0.1:23119/api/users/0"
DEFAULT_SUBDIR = "Reading Notes/Zotero Notes"


@dataclass(frozen=True)
class SyncConfig:
    target_dir: Path
    base_url: str = DEFAULT_BASE_URL
    page_limit: int = 100
    write_index: bool = True
    dry_run: bool = False


class ZoteroClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, timeout: int = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def get(
        self, path: str, params: dict[str, str | int] | None = None
    ) -> tuple[list[Any] | dict[str, Any], dict[str, str]]:
        query = urllib.parse.urlencode(params or {})
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{query}"
        req = urllib.request.Request(url, headers={"Zotero-API-Version": "3"})
        with urllib.request.urlopen(req, timeout=self.timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return payload, dict(response.headers.items())

    def check(self) -> dict[str, str | int | bool | None]:
        try:
            _, headers = self.get("/items", {"itemType": "note", "limit": 1, "format": "json"})
        except urllib.error.URLError as exc:
            return {"ok": False, "base_url": self.base_url, "error": str(exc)}
        return {
            "ok": True,
            "base_url": self.base_url,
            "zotero_version": headers.get("X-Zotero-Version"),
            "api_version": headers.get("Zotero-API-Version"),
            "schema_version": headers.get("Zotero-Schema-Version"),
            "note_count": int(headers.get("Total-Results", "0")),
        }

    def fetch_paginated(
        self, path: str, params: dict[str, str | int], limit: int = 100
    ) -> list[dict[str, Any]]:
        start = 0
        results: list[dict[str, Any]] = []
        total = None
        while True:
            page_params = dict(params)
            page_params.update({"start": start, "limit": limit, "format": "json"})
            page, headers = self.get(path, page_params)
            if not isinstance(page, list):
                raise RuntimeError(f"Expected list response for {path}, got {type(page).__name__}")
            if total is None:
                raw_total = headers.get("Total-Results")
                total = int(raw_total) if raw_total is not None else None
            results.extend(page)
            if not page:
                break
            start += len(page)
            if total is not None and start >= total:
                break
        return results

    def fetch_notes(self, limit: int = 100) -> list[dict[str, Any]]:
        return self.fetch_paginated("/items", {"itemType": "note"}, limit=limit)

    def fetch_parent_items(self, parent_keys: set[str]) -> dict[str, dict[str, Any]]:
        parents: dict[str, dict[str, Any]] = {}
        keys = sorted(parent_keys)
        for index in range(0, len(keys), 40):
            batch = keys[index : index + 40]
            payload, _ = self.get(
                "/items",
                {
                    "itemKey": ",".join(batch),
                    "format": "json",
                    "limit": 100,
                },
            )
            if isinstance(payload, list):
                requested = set(batch)
                for item in payload:
                    key = item.get("key")
                    data = item.get("data", {})
                    if key in requested and data.get("itemType") != "note":
                        parents[key] = item

        missing = sorted(parent_keys - set(parents))
        for key in missing:
            try:
                item, _ = self.get(f"/items/{key}", {"format": "json"})
            except Exception:
                continue
            if isinstance(item, dict):
                parents[key] = item
        return parents


class PlainTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = re.sub(r"\s+", " ", data).strip()
        if text:
            self.parts.append(text)

    def text(self) -> str:
        return "\n".join(self.parts)


class MarkdownConverter(HTMLParser):
    BLOCK_TAGS = {"div", "p", "section", "article"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.list_stack: list[dict[str, int | str]] = []
        self.link_stack: list[str] = []
        self.just_started_li = False

    def append(self, value: str) -> None:
        self.parts.append(value)

    def block_break(self) -> None:
        text = "".join(self.parts)
        if not text:
            return
        if text.endswith("\n\n"):
            return
        if text.endswith("\n"):
            self.append("\n")
        else:
            self.append("\n\n")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {key: value or "" for key, value in attrs}
        if tag in self.BLOCK_TAGS:
            if not self.just_started_li:
                self.block_break()
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.block_break()
            self.append("#" * int(tag[1]) + " ")
        elif tag == "br":
            self.append("\n")
        elif tag == "ul":
            self.block_break()
            self.list_stack.append({"type": "ul", "index": 0})
        elif tag == "ol":
            self.block_break()
            self.list_stack.append({"type": "ol", "index": 0})
        elif tag == "li":
            self.block_break()
            indent = "  " * max(len(self.list_stack) - 1, 0)
            marker = "- "
            if self.list_stack and self.list_stack[-1]["type"] == "ol":
                self.list_stack[-1]["index"] = int(self.list_stack[-1]["index"]) + 1
                marker = f"{self.list_stack[-1]['index']}. "
            self.append(indent + marker)
            self.just_started_li = True
        elif tag in {"strong", "b"}:
            self.append("**")
        elif tag in {"em", "i"}:
            self.append("*")
        elif tag == "code":
            self.append("`")
        elif tag == "blockquote":
            self.block_break()
            self.append("> ")
        elif tag == "a":
            href = attrs_dict.get("href", "")
            self.link_stack.append(href)
            self.append("[")
        elif tag == "img":
            src = attrs_dict.get("src", "")
            alt = attrs_dict.get("alt", "")
            if src:
                self.append(f"![{alt}]({src})")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "section", "article"}:
            self.block_break()
        elif tag in {"ul", "ol"}:
            if self.list_stack:
                self.list_stack.pop()
            self.block_break()
        elif tag == "li":
            self.append("\n")
        elif tag in {"strong", "b"}:
            self.append("**")
        elif tag in {"em", "i"}:
            self.append("*")
        elif tag == "code":
            self.append("`")
        elif tag == "blockquote":
            self.block_break()
        elif tag == "a":
            href = self.link_stack.pop() if self.link_stack else ""
            self.append(f"]({href})" if href else "]")

    def handle_data(self, data: str) -> None:
        if not data:
            return
        text = re.sub(r"\s+", " ", data)
        if text.strip():
            if self.just_started_li:
                text = text.lstrip()
            elif self.parts and self.parts[-1].endswith(("\n", " ")):
                text = text.lstrip()
            if text.endswith(" "):
                text = text.rstrip() + " "
            self.just_started_li = False
            self.append(text)

    def markdown(self) -> str:
        text = html.unescape("".join(self.parts))
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r"(\n\s*[-*] .*)\n\n(?=\s*[-*] )", r"\1\n", text)
        return text.strip()


def html_to_plain_text(value: str) -> str:
    parser = PlainTextExtractor()
    parser.feed(value or "")
    return parser.text()


def html_to_markdown(value: str) -> str:
    parser = MarkdownConverter()
    parser.feed(value or "")
    return parser.markdown()


def yaml_quote(value: object) -> str:
    if value is None:
        return '""'
    return json.dumps(str(value), ensure_ascii=False)


def yaml_list(values: list[str]) -> str:
    if not values:
        return "[]"
    return "\n" + "\n".join(f"  - {yaml_quote(value)}" for value in values)


def creator_name(creator: dict[str, Any]) -> str:
    if creator.get("name"):
        return str(creator["name"])
    pieces = [creator.get("firstName", ""), creator.get("lastName", "")]
    return " ".join(piece for piece in pieces if piece).strip()


def item_year(item_data: dict[str, Any]) -> str:
    date = item_data.get("date", "")
    match = re.search(r"\b(\d{4})\b", date)
    return match.group(1) if match else ""


def safe_filename(title: str, key: str) -> str:
    clean = re.sub(r"[\\/:*?\"<>|#^[\]]+", " - ", title)
    clean = re.sub(r"\s+", " ", clean).strip(" .")
    clean = clean.strip(" -")
    if not clean:
        clean = "Zotero Note"
    if len(clean) > 120:
        clean = clean[:120].rstrip(" .")
    return f"{clean} [{key}].md"


def first_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def build_markdown(
    note_item: dict[str, Any], parent_item: dict[str, Any] | None
) -> tuple[str, str, dict[str, Any]]:
    data = note_item.get("data", {})
    key = note_item.get("key") or data.get("key", "")
    parent_key = data.get("parentItem", "")
    parent_data = parent_item.get("data", {}) if parent_item else {}
    parent_title = parent_data.get("title", "")
    note_html = data.get("note", "")
    note_plain = html_to_plain_text(note_html)
    note_markdown = html_to_markdown(note_html)
    note_title = first_line(note_plain)
    display_title = parent_title or note_title or f"Zotero Note {key}"
    filename = safe_filename(display_title, key)
    tags = [tag.get("tag", "") for tag in data.get("tags", []) if tag.get("tag")]
    parent_creators = [
        name
        for name in (creator_name(creator) for creator in parent_data.get("creators", []))
        if name
    ]
    generated_at = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")

    metadata = {
        "key": key,
        "file": filename,
        "title": display_title,
        "parent_key": parent_key,
        "parent_title": parent_title,
        "date_modified": data.get("dateModified", ""),
    }

    frontmatter = [
        "---",
        "source: zotero",
        "tags:",
        "  - zotero-note",
        f"zotero_key: {yaml_quote(key)}",
        f"zotero_version: {data.get('version', note_item.get('version', ''))}",
        f"zotero_select: {yaml_quote(f'zotero://select/library/items/{key}')}",
        f"parent_key: {yaml_quote(parent_key)}",
        f"parent_title: {yaml_quote(parent_title)}",
        f"parent_type: {yaml_quote(parent_data.get('itemType', ''))}",
        f"parent_year: {yaml_quote(item_year(parent_data))}",
        f"parent_creators: {yaml_list(parent_creators)}",
        f"zotero_tags: {yaml_list(tags)}",
        f"date_added: {yaml_quote(data.get('dateAdded', ''))}",
        f"date_modified: {yaml_quote(data.get('dateModified', ''))}",
        f"synced_at: {yaml_quote(generated_at)}",
        "---",
        "",
    ]

    body = [
        f"# {display_title}",
        "",
        f"- Zotero note: [open]({f'zotero://select/library/items/{key}'})",
    ]
    if parent_key:
        body.append(f"- Zotero parent: [open]({f'zotero://select/library/items/{parent_key}'})")
    if parent_creators:
        body.append(f"- Creators: {', '.join(parent_creators)}")
    if parent_data.get("itemType"):
        item_type = parent_data.get("itemType")
        year = item_year(parent_data)
        suffix = f", {year}" if year else ""
        body.append(f"- Parent item: {item_type}{suffix}")
    if note_title and note_title != display_title:
        body.append(f"- Note starts: {note_title}")
    body.extend(["", "## Note", "", note_markdown or "_Empty Zotero note._", ""])

    return filename, "\n".join(frontmatter + body), metadata


def write_index(target_dir: Path, manifest: list[dict[str, Any]], generated_at: str) -> None:
    lines = [
        "# Zotero Notes Index",
        "",
        f"Synced at: {generated_at}",
        f"Total notes: {len(manifest)}",
        "",
        "## Notes",
        "",
    ]
    for entry in sorted(manifest, key=lambda item: (item.get("title") or "", item.get("key") or "")):
        title = entry.get("title") or entry.get("key")
        file = entry.get("file")
        parent_key = entry.get("parent_key") or ""
        parent_bit = f" · parent `{parent_key}`" if parent_key else ""
        lines.append(f"- [[{Path(file).stem}|{title}]] `{entry.get('key')}`{parent_bit}")
    (target_dir / "_index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def sync(config: SyncConfig) -> dict[str, int | str | bool]:
    client = ZoteroClient(config.base_url)
    notes = client.fetch_notes(limit=config.page_limit)
    parent_keys = {
        item.get("data", {}).get("parentItem")
        for item in notes
        if item.get("data", {}).get("parentItem")
    }
    parents = client.fetch_parent_items(set(parent_keys))
    generated_at = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")

    manifest: list[dict[str, Any]] = []
    for note in notes:
        data = note.get("data", {})
        parent = parents.get(data.get("parentItem", ""))
        filename, markdown, metadata = build_markdown(note, parent)
        manifest.append(metadata)
        if not config.dry_run:
            config.target_dir.mkdir(parents=True, exist_ok=True)
            (config.target_dir / filename).write_text(markdown, encoding="utf-8")

    manifest_path = config.target_dir / ".zotero-notes-manifest.json"
    if not config.dry_run:
        manifest_path.write_text(
            json.dumps(
                {
                    "generated_at": generated_at,
                    "source": config.base_url,
                    "target_dir": str(config.target_dir),
                    "note_count": len(manifest),
                    "notes": sorted(manifest, key=lambda item: item["key"]),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        if config.write_index:
            write_index(config.target_dir, manifest, generated_at)

    return {
        "ok": True,
        "dry_run": config.dry_run,
        "notes": len(notes),
        "parents": len(parents),
        "target_dir": str(config.target_dir),
        "manifest": str(manifest_path),
    }


def load_config(path: Path | None) -> dict[str, Any]:
    if not path:
        return {}
    with path.expanduser().open("r", encoding="utf-8") as file:
        return json.load(file)


def resolve_target(args: argparse.Namespace, config: dict[str, Any], default_target: Path | None) -> Path:
    if args.target:
        return args.target.expanduser()
    if config.get("target"):
        return Path(config["target"]).expanduser()
    vault = args.vault or config.get("vault")
    if vault:
        subdir = args.subdir or config.get("subdir") or DEFAULT_SUBDIR
        return Path(vault).expanduser() / subdir
    if default_target:
        return default_target.expanduser()
    raise ValueError("Provide --target, --vault, or a config file with target/vault.")


def build_parser(default_target: Path | None = None) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="Path to a JSON config file.")
    parser.add_argument("--vault", type=Path, help="Obsidian vault path.")
    parser.add_argument("--target", type=Path, help="Exact output folder for synced notes.")
    parser.add_argument(
        "--subdir",
        default=None,
        help=f"Folder inside --vault. Defaults to {DEFAULT_SUBDIR!r}.",
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help=f"Zotero local API base URL. Defaults to {DEFAULT_BASE_URL!r}.",
    )
    parser.add_argument("--page-limit", type=int, default=None, help="Zotero API page size.")
    parser.add_argument("--dry-run", action="store_true", help="Read Zotero but do not write files.")
    parser.add_argument("--no-index", action="store_true", help="Skip writing _index.md.")
    parser.add_argument("--check", action="store_true", help="Only check Zotero local API reachability.")
    return parser


def main(argv: list[str] | None = None, default_target: Path | None = None) -> int:
    parser = build_parser(default_target=default_target)
    args = parser.parse_args(argv)

    try:
        config_file = load_config(args.config)
        base_url = args.base_url or config_file.get("base_url") or DEFAULT_BASE_URL
        client = ZoteroClient(base_url)
        if args.check:
            print(json.dumps(client.check(), ensure_ascii=False, indent=2))
            return 0

        target_dir = resolve_target(args, config_file, default_target)
        config = SyncConfig(
            target_dir=target_dir,
            base_url=base_url,
            page_limit=args.page_limit or int(config_file.get("page_limit", 100)),
            write_index=not (args.no_index or bool(config_file.get("no_index", False))),
            dry_run=args.dry_run,
        )
        result = sync(config)
    except Exception as exc:
        print(f"Sync failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
