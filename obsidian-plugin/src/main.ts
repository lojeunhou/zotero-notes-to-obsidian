import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl
} from "obsidian";

const DEFAULT_BASE_URL = "http://127.0.0.1:23119/api/users/0";
const DEFAULT_TARGET_FOLDER = "Reading Notes/Zotero Notes";

interface ZoteroNotesSettings {
  baseUrl: string;
  targetFolder: string;
  pageLimit: number;
  writeIndex: boolean;
  openIndexAfterSync: boolean;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
}

const DEFAULT_SETTINGS: ZoteroNotesSettings = {
  baseUrl: DEFAULT_BASE_URL,
  targetFolder: DEFAULT_TARGET_FOLDER,
  pageLimit: 100,
  writeIndex: true,
  openIndexAfterSync: false,
  syncOnStartup: false,
  syncIntervalMinutes: 0
};

interface ZoteroApiItem {
  key?: string;
  version?: number;
  data?: Record<string, any>;
}

interface ZoteroCheckResult {
  ok: boolean;
  baseUrl: string;
  noteCount?: number;
  zoteroVersion?: string;
  apiVersion?: string;
  schemaVersion?: string;
  error?: string;
}

interface SyncResult {
  ok: boolean;
  notes: number;
  parents: number;
  targetFolder: string;
  manifestPath: string;
  indexPath?: string;
}

interface NoteManifestEntry {
  key: string;
  file: string;
  title: string;
  parent_key: string;
  parent_title: string;
  date_modified: string;
}

class ZoteroClient {
  constructor(private readonly baseUrl: string) {}

  async check(): Promise<ZoteroCheckResult> {
    try {
      const response = await this.get<ZoteroApiItem[]>("/items", {
        itemType: "note",
        limit: 1,
        format: "json"
      });
      return {
        ok: true,
        baseUrl: this.baseUrl,
        noteCount: parseIntHeader(response.headers, "Total-Results"),
        zoteroVersion: getHeader(response.headers, "X-Zotero-Version"),
        apiVersion: getHeader(response.headers, "Zotero-API-Version"),
        schemaVersion: getHeader(response.headers, "Zotero-Schema-Version")
      };
    } catch (error) {
      return {
        ok: false,
        baseUrl: this.baseUrl,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async get<T>(
    path: string,
    params: Record<string, string | number> = {}
  ): Promise<{ data: T; headers: Record<string, string> }> {
    const url = buildUrl(this.baseUrl, path, params);
    const response = await requestUrl({
      url,
      method: "GET",
      headers: {
        "Zotero-API-Version": "3"
      }
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Zotero API returned ${response.status} for ${path}`);
    }

    return {
      data: response.json as T,
      headers: response.headers
    };
  }

  async fetchPaginated(
    path: string,
    params: Record<string, string | number>,
    limit: number
  ): Promise<ZoteroApiItem[]> {
    const results: ZoteroApiItem[] = [];
    let start = 0;
    let total: number | undefined;

    while (true) {
      const pageParams = {
        ...params,
        start,
        limit,
        format: "json"
      };
      const response = await this.get<ZoteroApiItem[]>(path, pageParams);
      if (!Array.isArray(response.data)) {
        throw new Error(`Expected a list response for ${path}`);
      }
      if (total === undefined) {
        total = parseIntHeader(response.headers, "Total-Results");
      }

      results.push(...response.data);
      if (response.data.length === 0) {
        break;
      }
      start += response.data.length;
      if (total !== undefined && start >= total) {
        break;
      }
    }

    return results;
  }

  fetchNotes(limit: number): Promise<ZoteroApiItem[]> {
    return this.fetchPaginated("/items", { itemType: "note" }, limit);
  }

  async fetchParentItems(parentKeys: Set<string>): Promise<Map<string, ZoteroApiItem>> {
    const parents = new Map<string, ZoteroApiItem>();
    const keys = Array.from(parentKeys).sort();

    for (let index = 0; index < keys.length; index += 40) {
      const batch = keys.slice(index, index + 40);
      const response = await this.get<ZoteroApiItem[]>("/items", {
        itemKey: batch.join(","),
        format: "json",
        limit: 100
      });

      for (const item of response.data) {
        const key = item.key;
        const data = item.data ?? {};
        if (key && batch.includes(key) && data.itemType !== "note") {
          parents.set(key, item);
        }
      }
    }

    for (const key of keys) {
      if (parents.has(key)) {
        continue;
      }
      try {
        const response = await this.get<ZoteroApiItem>(`/items/${key}`, {
          format: "json"
        });
        if (response.data.key) {
          parents.set(response.data.key, response.data);
        }
      } catch {
        // Missing/deleted parent items should not block note export.
      }
    }

    return parents;
  }
}

export default class ZoteroNotesToObsidianPlugin extends Plugin {
  settings: ZoteroNotesSettings = DEFAULT_SETTINGS;
  private statusBar: HTMLElement | null = null;
  private syncInProgress = false;
  private syncIntervalId: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = this.addStatusBarItem();
    this.setStatus("Zotero notes ready");

    this.addRibbonIcon("refresh-cw", "Sync Zotero notes", () => {
      void this.syncWithNotice();
    });

    this.addCommand({
      id: "sync-zotero-notes",
      name: "Sync Zotero notes",
      callback: () => {
        void this.syncWithNotice();
      }
    });

    this.addCommand({
      id: "check-zotero-local-api",
      name: "Check Zotero local API",
      callback: () => {
        void this.checkWithNotice();
      }
    });

    this.addSettingTab(new ZoteroNotesSettingTab(this.app, this));
    this.configureInterval();

    if (this.settings.syncOnStartup) {
      window.setTimeout(() => {
        void this.syncWithNotice(false);
      }, 2000);
    }
  }

  onunload(): void {
    this.clearSyncInterval();
  }

  async loadSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData())
    };
  }

  async saveSettings(): Promise<void> {
    this.settings.targetFolder = sanitizeVaultPath(this.settings.targetFolder);
    this.settings.baseUrl = this.settings.baseUrl.trim().replace(/\/+$/, "");
    this.settings.pageLimit = Math.max(1, Math.floor(this.settings.pageLimit || 100));
    this.settings.syncIntervalMinutes = Math.max(
      0,
      Math.floor(this.settings.syncIntervalMinutes || 0)
    );
    await this.saveData(this.settings);
    this.configureInterval();
  }

  async checkWithNotice(): Promise<void> {
    const result = await new ZoteroClient(this.settings.baseUrl).check();
    if (result.ok) {
      new Notice(`Zotero is reachable. Notes: ${result.noteCount ?? 0}`);
      this.setStatus(`Zotero notes: ${result.noteCount ?? 0}`);
      return;
    }
    new Notice(`Zotero is not reachable: ${result.error ?? "unknown error"}`, 8000);
    this.setStatus("Zotero unavailable");
  }

  async syncWithNotice(showSuccess = true): Promise<void> {
    if (this.syncInProgress) {
      new Notice("Zotero sync is already running.");
      return;
    }

    this.syncInProgress = true;
    this.setStatus("Syncing Zotero notes...");
    try {
      const result = await this.syncNow();
      if (showSuccess) {
        new Notice(`Synced ${result.notes} Zotero notes.`);
      }
      this.setStatus(`Synced ${result.notes} Zotero notes`);

      if (this.settings.openIndexAfterSync && result.indexPath) {
        const file = this.app.vault.getAbstractFileByPath(result.indexPath);
        if (file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(file);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Zotero sync failed: ${message}`, 10000);
      this.setStatus("Zotero sync failed");
      console.error("Zotero Notes to Obsidian sync failed", error);
    } finally {
      this.syncInProgress = false;
    }
  }

  async syncNow(): Promise<SyncResult> {
    const settings = this.settings;
    const targetFolder = sanitizeVaultPath(settings.targetFolder);
    const client = new ZoteroClient(settings.baseUrl);

    const notes = await client.fetchNotes(settings.pageLimit);
    const parentKeys = new Set<string>();
    for (const item of notes) {
      const parentKey = item.data?.parentItem;
      if (typeof parentKey === "string" && parentKey.length > 0) {
        parentKeys.add(parentKey);
      }
    }

    const parents = await client.fetchParentItems(parentKeys);
    const manifest: NoteManifestEntry[] = [];
    const syncedAt = new Date().toISOString();

    await ensureFolder(this.app, targetFolder);

    for (const note of notes) {
      const parentKey = note.data?.parentItem;
      const parent = typeof parentKey === "string" ? parents.get(parentKey) : undefined;
      const built = buildMarkdown(note, parent, syncedAt);
      await this.app.vault.adapter.write(
        normalizePath(`${targetFolder}/${built.fileName}`),
        built.markdown
      );
      manifest.push(built.manifestEntry);
    }

    const manifestPath = normalizePath(`${targetFolder}/.zotero-notes-manifest.json`);
    await this.app.vault.adapter.write(
      manifestPath,
      JSON.stringify(
        {
          generated_at: syncedAt,
          source: settings.baseUrl,
          target_dir: targetFolder,
          note_count: manifest.length,
          notes: manifest.sort((a, b) => a.key.localeCompare(b.key))
        },
        null,
        2
      ) + "\n"
    );

    let indexPath: string | undefined;
    if (settings.writeIndex) {
      indexPath = normalizePath(`${targetFolder}/_index.md`);
      await this.app.vault.adapter.write(indexPath, buildIndex(manifest, syncedAt));
    }

    return {
      ok: true,
      notes: notes.length,
      parents: parents.size,
      targetFolder,
      manifestPath,
      indexPath
    };
  }

  configureInterval(): void {
    this.clearSyncInterval();
    const minutes = this.settings.syncIntervalMinutes;
    if (minutes <= 0) {
      return;
    }

    this.syncIntervalId = window.setInterval(() => {
      void this.syncWithNotice(false);
    }, minutes * 60 * 1000);
    this.registerInterval(this.syncIntervalId);
  }

  private clearSyncInterval(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  private setStatus(text: string): void {
    this.statusBar?.setText(text);
  }
}

class ZoteroNotesSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ZoteroNotesToObsidianPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Zotero Notes to Obsidian" });

    new Setting(containerEl)
      .setName("Zotero local API URL")
      .setDesc("Default Zotero Desktop local API endpoint.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_BASE_URL)
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Target folder")
      .setDesc("Folder inside this Obsidian vault where synced notes will be written.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_TARGET_FOLDER)
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API page size")
      .setDesc("Number of Zotero notes to fetch per request.")
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.pageLimit))
          .onChange(async (value) => {
            const next = Number.parseInt(value, 10);
            this.plugin.settings.pageLimit = Number.isFinite(next) ? next : 100;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Write index")
      .setDesc("Create or update _index.md after each sync.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.writeIndex).onChange(async (value) => {
          this.plugin.settings.writeIndex = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Open index after sync")
      .setDesc("Open _index.md when a manual sync finishes.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openIndexAfterSync).onChange(async (value) => {
          this.plugin.settings.openIndexAfterSync = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a sync shortly after Obsidian loads the plugin.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto-sync interval")
      .setDesc("Minutes between automatic syncs while Obsidian is open. Use 0 to disable.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const next = Number.parseInt(value, 10);
            this.plugin.settings.syncIntervalMinutes = Number.isFinite(next) ? next : 0;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Actions")
      .setDesc("Run sync or check Zotero without leaving settings.")
      .addButton((button) =>
        button.setButtonText("Check Zotero").onClick(() => {
          void this.plugin.checkWithNotice();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("Sync now")
          .setCta()
          .onClick(() => {
            void this.plugin.syncWithNotice();
          })
      );

    containerEl.createDiv({
      cls: "znto-sync-summary",
      text: "Install Zotero Desktop and keep it running while syncing. This plugin reads Zotero notes only; it does not write back to Zotero."
    });
  }
}

function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number>
): string {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  const queryString = query.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function getHeader(headers: Record<string, string>, key: string): string | undefined {
  const lowerKey = key.toLowerCase();
  for (const [header, value] of Object.entries(headers)) {
    if (header.toLowerCase() === lowerKey) {
      return value;
    }
  }
  return undefined;
}

function parseIntHeader(headers: Record<string, string>, key: string): number | undefined {
  const value = getHeader(headers, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildMarkdown(
  noteItem: ZoteroApiItem,
  parentItem: ZoteroApiItem | undefined,
  syncedAt: string
): { fileName: string; markdown: string; manifestEntry: NoteManifestEntry } {
  const data = noteItem.data ?? {};
  const key = String(noteItem.key ?? data.key ?? "");
  const parentKey = typeof data.parentItem === "string" ? data.parentItem : "";
  const parentData = parentItem?.data ?? {};
  const parentTitle = asString(parentData.title);
  const noteHtml = asString(data.note);
  const noteTitle = firstLine(htmlToPlainText(noteHtml));
  const displayTitle = parentTitle || noteTitle || `Zotero Note ${key}`;
  const fileName = safeFileName(displayTitle, key);
  const tags = Array.isArray(data.tags)
    ? data.tags.map((tag) => asString(tag?.tag)).filter(Boolean)
    : [];
  const parentCreators = Array.isArray(parentData.creators)
    ? parentData.creators.map(creatorName).filter(Boolean)
    : [];

  const manifestEntry: NoteManifestEntry = {
    key,
    file: fileName,
    title: displayTitle,
    parent_key: parentKey,
    parent_title: parentTitle,
    date_modified: asString(data.dateModified)
  };

  const frontmatter = [
    "---",
    "source: zotero",
    "tags:",
    "  - zotero-note",
    `zotero_key: ${yamlQuote(key)}`,
    `zotero_version: ${asString(data.version ?? noteItem.version) || 0}`,
    `zotero_select: ${yamlQuote(`zotero://select/library/items/${key}`)}`,
    `parent_key: ${yamlQuote(parentKey)}`,
    `parent_title: ${yamlQuote(parentTitle)}`,
    `parent_type: ${yamlQuote(asString(parentData.itemType))}`,
    `parent_year: ${yamlQuote(itemYear(parentData))}`,
    `parent_creators: ${yamlList(parentCreators)}`,
    `zotero_tags: ${yamlList(tags)}`,
    `date_added: ${yamlQuote(asString(data.dateAdded))}`,
    `date_modified: ${yamlQuote(asString(data.dateModified))}`,
    `synced_at: ${yamlQuote(syncedAt)}`,
    "---",
    ""
  ];

  const body = [
    `# ${displayTitle}`,
    "",
    `- Zotero note: [open](zotero://select/library/items/${key})`
  ];

  if (parentKey) {
    body.push(`- Zotero parent: [open](zotero://select/library/items/${parentKey})`);
  }
  if (parentCreators.length > 0) {
    body.push(`- Creators: ${parentCreators.join(", ")}`);
  }
  if (parentData.itemType) {
    const year = itemYear(parentData);
    body.push(`- Parent item: ${parentData.itemType}${year ? `, ${year}` : ""}`);
  }
  if (noteTitle && noteTitle !== displayTitle) {
    body.push(`- Note starts: ${noteTitle}`);
  }

  body.push("", "## Note", "", htmlToMarkdown(noteHtml) || "_Empty Zotero note._", "");

  return {
    fileName,
    markdown: [...frontmatter, ...body].join("\n"),
    manifestEntry
  };
}

function buildIndex(manifest: NoteManifestEntry[], syncedAt: string): string {
  const lines = [
    "# Zotero Notes Index",
    "",
    `Synced at: ${syncedAt}`,
    `Total notes: ${manifest.length}`,
    "",
    "## Notes",
    ""
  ];

  for (const entry of [...manifest].sort((a, b) => a.title.localeCompare(b.title))) {
    const stem = entry.file.replace(/\.md$/i, "");
    const parent = entry.parent_key ? ` · parent \`${entry.parent_key}\`` : "";
    lines.push(`- [[${stem}|${entry.title}]] \`${entry.key}\`${parent}`);
  }

  return `${lines.join("\n")}\n`;
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const normalized = sanitizeVaultPath(folder);
  const parts = normalized.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) {
      await app.vault.createFolder(current);
    }
  }
}

function sanitizeVaultPath(path: string): string {
  return normalizePath((path || DEFAULT_TARGET_FOLDER).trim())
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function htmlToPlainText(source: string): string {
  const doc = new DOMParser().parseFromString(source || "", "text/html");
  const blockNodes = Array.from(
    doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote")
  );
  const lines = blockNodes
    .map((node) => normalizeInline(node.textContent ?? ""))
    .filter(Boolean);
  if (lines.length > 0) {
    return lines.join("\n");
  }
  return normalizeInline(doc.body.textContent ?? "");
}

function htmlToMarkdown(source: string): string {
  const doc = new DOMParser().parseFromString(source || "", "text/html");
  const markdown = Array.from(doc.body.childNodes)
    .map((node) => renderNode(node, { inListItem: false, depth: 0 }))
    .join("");
  return normalizeMarkdown(markdown);
}

interface RenderContext {
  inListItem: boolean;
  depth: number;
}

function renderNode(node: Node, context: RenderContext): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeInline(node.textContent ?? "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const children = () =>
    Array.from(element.childNodes)
      .map((child) => renderNode(child, context))
      .join("");

  if (/^h[1-6]$/.test(tag)) {
    return `\n\n${"#".repeat(Number(tag.charAt(1)))} ${children().trim()}\n\n`;
  }
  if (["p", "div", "section", "article"].includes(tag)) {
    const text = children().trim();
    if (!text) {
      return "";
    }
    return context.inListItem ? text : `\n\n${text}\n\n`;
  }
  if (tag === "br") {
    return "\n";
  }
  if (tag === "ul" || tag === "ol") {
    return `\n${renderList(element, tag === "ol", context.depth)}\n`;
  }
  if (tag === "li") {
    return children();
  }
  if (tag === "strong" || tag === "b") {
    return `**${children().trim()}**`;
  }
  if (tag === "em" || tag === "i") {
    return `*${children().trim()}*`;
  }
  if (tag === "code") {
    return `\`${children().trim()}\``;
  }
  if (tag === "blockquote") {
    return `\n\n> ${children().trim().replace(/\n/g, "\n> ")}\n\n`;
  }
  if (tag === "a") {
    const href = element.getAttribute("href") ?? "";
    const text = children().trim();
    return href ? `[${text}](${href})` : text;
  }
  if (tag === "img") {
    const src = element.getAttribute("src") ?? "";
    const alt = element.getAttribute("alt") ?? "";
    return src ? `![${alt}](${src})` : "";
  }

  return children();
}

function renderList(element: HTMLElement, ordered: boolean, depth: number): string {
  const lines: string[] = [];
  let index = 1;

  for (const child of Array.from(element.children)) {
    if (child.tagName.toLowerCase() !== "li") {
      continue;
    }
    const marker = ordered ? `${index}. ` : "- ";
    const nested: string[] = [];
    const inline: string[] = [];

    for (const node of Array.from(child.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const childElement = node as HTMLElement;
        const tag = childElement.tagName.toLowerCase();
        if (tag === "ul" || tag === "ol") {
          nested.push(renderList(childElement, tag === "ol", depth + 1));
          continue;
        }
      }
      inline.push(renderNode(node, { inListItem: true, depth }));
    }

    lines.push(`${"  ".repeat(depth)}${marker}${normalizeInline(inline.join("")).trim()}`);
    lines.push(...nested.filter(Boolean).map((text) => text.replace(/\n+$/, "")));
    index += 1;
  }

  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, " ");
}

function firstLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function safeFileName(title: string, key: string): string {
  let clean = title.replace(/[\\/:*?"<>|#^[\]]+/g, " - ");
  clean = clean.replace(/\s+/g, " ").trim().replace(/^[ .-]+|[ .-]+$/g, "");
  if (!clean) {
    clean = "Zotero Note";
  }
  if (clean.length > 120) {
    clean = clean.slice(0, 120).replace(/[ .-]+$/g, "");
  }
  return `${clean} [${key}].md`;
}

function creatorName(creator: Record<string, any>): string {
  if (creator.name) {
    return asString(creator.name);
  }
  return [creator.firstName, creator.lastName].map(asString).filter(Boolean).join(" ");
}

function itemYear(itemData: Record<string, any>): string {
  const date = asString(itemData.date);
  return date.match(/\b(\d{4})\b/)?.[1] ?? "";
}

function yamlQuote(value: unknown): string {
  return JSON.stringify(asString(value));
}

function yamlList(values: string[]): string {
  if (values.length === 0) {
    return "[]";
  }
  return `\n${values.map((value) => `  - ${yamlQuote(value)}`).join("\n")}`;
}

function asString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}
