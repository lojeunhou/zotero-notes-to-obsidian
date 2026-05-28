# Zotero Notes to Obsidian

[English](README.en.md)

把 Zotero Desktop 里的笔记同步到 Obsidian vault，并保存为 Markdown 文件。

这是一个本地优先的小工具，适合把 Zotero 中的批注、摘录、阅读笔记带进 Obsidian，而不用一条条手动导出。

## 功能

- 从 Zotero Desktop 的本地 API 读取 note。
- 将 Zotero note 的 HTML 内容转换成 Markdown。
- 每条 Zotero note 生成一个 Markdown 文件。
- 自动写入 frontmatter：Zotero key、父条目标题、作者、年份、标签、日期和 `zotero://` 链接。
- 生成 `_index.md`，方便在 Obsidian 中浏览全部同步笔记。
- 生成 `.zotero-notes-manifest.json`，用于检查同步结果。

## 运行要求

- Python 3.10 或更新版本
- 本机已打开 Zotero Desktop
- Zotero 本地 API 可访问：`http://127.0.0.1:23119`
- 一个本机 Obsidian vault 文件夹

本工具没有第三方 Python 依赖。

## 安装

从本地仓库安装：

```bash
python3 -m pip install .
```

开发模式安装：

```bash
python3 -m pip install -e .
```

## 快速开始

检查 Zotero 是否可访问：

```bash
zotero-notes-to-obsidian --check
```

同步到一个 Obsidian vault：

```bash
zotero-notes-to-obsidian --vault "/path/to/Your Obsidian Vault"
```

默认会写入 vault 内的这个目录：

```text
Reading Notes/Zotero Notes
```

如果想指定精确输出目录：

```bash
zotero-notes-to-obsidian --target "/path/to/Your Vault/Zotero Notes"
```

只预览读取结果，不写入文件：

```bash
zotero-notes-to-obsidian --vault "/path/to/Your Vault" --dry-run
```

## Obsidian 插件

仓库中也包含一个 Obsidian 插件版本，位于 [`obsidian-plugin/`](obsidian-plugin/)。

插件版提供：

- Obsidian ribbon 按钮一键同步
- 命令面板同步命令
- Zotero local API 检查命令
- 设置页
- 可选的启动同步和定时间隔同步

构建：

```bash
cd obsidian-plugin
npm install
npm run build
```

手动安装时，把 `main.js`、`manifest.json`、`styles.css` 复制到：

```text
YourVault/.obsidian/plugins/zotero-notes-to-obsidian/
```

## 配置文件

复制示例配置并修改路径：

```bash
cp config.example.json config.json
zotero-notes-to-obsidian --config config.json
```

示例：

```json
{
  "vault": "/path/to/Obsidian/My Vault",
  "subdir": "Reading Notes/Zotero Notes",
  "base_url": "http://127.0.0.1:23119/api/users/0",
  "page_limit": 100
}
```

## 输出格式

每条同步后的笔记大致如下：

```markdown
---
source: zotero
tags:
  - zotero-note
zotero_key: "ABCD1234"
zotero_select: "zotero://select/library/items/ABCD1234"
parent_title: "Example Book"
parent_creators:
  - "Jane Author"
parent_year: "2024"
---

# Example Book

- Zotero note: [open](zotero://select/library/items/ABCD1234)
- Zotero parent: [open](zotero://select/library/items/PARENT01)

## Note

这里是 Zotero note 的正文。
```

## 定时同步

你可以用 cron、launchd、Windows Task Scheduler、systemd timer 或任何自动化工具定期运行同步命令。

例如：每周三和周日 14:00 同步一次：

```cron
0 14 * * 0,3 zotero-notes-to-obsidian --config /path/to/config.json
```

## 注意事项

- 本工具只读取 Zotero，不会写回 Zotero。
- 目前不同步 PDF 或附件。
- 下次同步时，同一个 Zotero key 对应的 Markdown 文件会被覆盖更新。
- 文件名包含 Zotero note key，因此父条目标题重复也不会互相覆盖。
- Zotero note HTML 中的图片引用会尽量保留为 Markdown 图片链接，但还没有实现附件提取。

## 开发

运行测试：

```bash
python3 -m unittest discover -s tests
```

## 许可证

MIT
