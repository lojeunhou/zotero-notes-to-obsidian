# Obsidian Plugin

这是 `Zotero Notes to Obsidian` 的 Obsidian 插件版本。

它会从本机 Zotero Desktop local API 读取 Zotero notes，并写入当前 Obsidian vault。

## 当前功能

- Ribbon 按钮：一键同步 Zotero notes。
- 命令面板：`Sync Zotero notes`。
- 命令面板：`Check Zotero local API`。
- 设置页：Zotero API 地址、目标目录、分页大小、是否写入索引。
- 可选：Obsidian 启动后自动同步。
- 可选：Obsidian 打开期间按分钟间隔自动同步。

## 构建

```bash
cd obsidian-plugin
npm install
npm run build
```

构建后会生成 `main.js`。

## 手动安装

把下面这些文件复制到你的 vault：

```text
YourVault/.obsidian/plugins/zotero-notes-to-obsidian/
```

需要复制的文件：

```text
main.js
manifest.json
styles.css
```

然后在 Obsidian 设置中启用 community plugins，并启用 `Zotero Notes to Obsidian`。

## 注意

- 插件只读取 Zotero，不会写回 Zotero。
- 插件需要 Zotero Desktop 正在运行。
- Zotero local API 通常只在桌面端可用，因此插件标记为 desktop-only。
- 目前不同步 PDF 或附件。
