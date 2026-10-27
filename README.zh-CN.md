<p align="center">
  <img src="assets/banner.png" alt="Obsidian → 闪念贝壳" width="760">
</p>

# 闪念贝壳 for Obsidian

[English](README.md) | 简体中文

把 [Obsidian](https://obsidian.md) 里的笔记同步到 [闪念贝壳 (ideashell)](https://ideashell.site)：正文、标签、文件夹、图片一起过去。
第一次同步新建笔记，之后再同步会原地更新同一条，不会产生重复。

## 功能

| | |
|---|---|
| **同步当前笔记** | 命令面板、左侧贝壳图标，或在文件上右键。 |
| **同步整个文件夹** | 文件列表里右键文件夹 → *Sync folder to ideashell*，包含子文件夹。 |
| **同步多选的文件** | Cmd/Ctrl 多选若干文件（或文件夹）→ 右键 → *Sync N notes to ideashell*。 |
| **选中文字发闪念** | 编辑器里选中一段文字 → 右键 → *Send selection to ideashell*，生成一条独立的新笔记。 |
| **全部同步** | 发送所有 frontmatter 里标了 `ideashell: true` 的笔记，以及设置里列出的文件夹下的全部笔记。 |
| **文件夹映射** | `读书/2026/xx.md` 会进到闪念贝壳里名为 `读书/2026` 的文件夹。闪念贝壳的文件夹是单层的，所以用 Obsidian 的路径当文件夹名。在 Obsidian 里移动或改名，下次同步笔记会跟着挪。 |
| **标签** | frontmatter 的 `tags` 和正文里的 `#标签` 都会变成闪念贝壳的标签；默认额外加一个 `obsidian` 标签，方便在 App 里筛出来（可改）。 |
| **图片** | 正文里 `![[photo.png]]` 引用的本地图片（PNG/JPEG/GIF/WebP，每篇最多 9 张、单张 ≤ 10 MB）会上传并挂到笔记上；后来新加的图片下次同步时补上。 |
| **自动重同步**（默认关） | 打开后，已经同步过的笔记在你停止编辑几秒后自动重发。新笔记永远不会未经你操作就发出去。 |

同步是**单向**的：Obsidian → 闪念贝壳。在闪念贝壳 App 里的修改不会回流到 Obsidian。

### 从闪念贝壳导入（ideashell → Obsidian）

- 将全部笔记（或最近 7 / 30 / 90 / 365 天）连同 AI 摘要和录音转写导入为 Markdown 文件。
- 自动同步：仅手动（默认）、启动时，或每 1 分钟 / 15 分钟 / 30 分钟 / 1 小时 / 12 小时。
- 基于模板：用 `{{ideashell_*}}` 变量和 `{{#变量}}…{{/变量}}` 条件块自定义 frontmatter 与正文（默认模板 `Templates/ideashell.md`）。
- 去重：按 frontmatter 中的 `ideashell_id` 在整个库中查找，移动或重命名过的笔记不会重复导入。
- 「跳过已存在的笔记」默认开启，保留你在 Obsidian 中的修改。
- 仍在转写中的笔记会推迟到转写完成后再导入。
- 文件夹与文件名支持 `{date}`、`{date:格式}`、`{title}`、`{id}`，例如 `ideashell/{date:YYYY/MM}`。
- 导入的笔记不会被发送回闪念贝壳；从 Obsidian 发送过的笔记也不会被导入覆盖。
- 日记（Daily note）集成（默认关闭）：每条新导入的笔记会以链接形式写入其创建当天的日记，放在 `## ideashell` 标题下（标题不存在会自动添加）。日记文件夹与日期格式默认沿用 Obsidian 核心「日记」插件的设置；缺少的日记会按核心插件模板创建（可关闭）。已链接过的笔记不会重复添加。命令「Link imported notes in daily notes」可为之前导入的笔记补全链接。

命令：「Import new notes」（只列出上次导入之后新建的笔记）与「Import all notes (full re-scan)」（重新扫描整个时间范围）。模板变量与全部设置项见[英文说明](README.md#import-notes-from-ideashell)。

### 导入待办（ideashell 待办 → Obsidian 任务）

- 每条闪念贝壳待办变成一条任务：默认是一个 [TaskNotes](https://github.com/callumalpass/tasknotes) 任务文件（TaskForge 也能读取），也可以选择 [Tasks](https://publish.obsidian.md/tasks/) 插件的 emoji 格式任务行，写进一个固定文件，或写进待办日期当天的日记。
- 在设置里打开「Enable to-do import」，然后在命令面板运行「Import to-dos」，或在设置里点「Import to-dos」。打开「Include in scheduled import」后，定时导入时也会导入待办（默认关闭）。
- 去重：每条任务都带着待办 id（任务文件的 frontmatter 里是 `ideashell_todo_id`，任务行末尾是块 id `^ideashell-<id>`）。再次导入只会原地更新，不会产生重复；没有这个标记的任务一律不动。
- 保留你的修改：只写入闪念贝壳里自上次导入以来发生变化的字段。你在 Obsidian 里完成的任务不会被改回未完成；你删掉的任务不会再被导入。
- 在闪念贝壳里完成的待办，会在 Obsidian 里标为完成，完成日期记为导入当天（闪念贝壳不提供完成时间）。
- 双向完成（「Two-way completion」，默认关闭）：在 Obsidian 里完成一条导入的任务，闪念贝壳里的待办也会被标为完成。除此之外不会向闪念贝壳写回任何内容。
- 待办内容按纯文本处理：去掉换行、开头的 `- [ ]` 和 Tasks 的 emoji 标记，并转义 `[[`、`<`、`#标签` 和 `%%`，避免变成链接、HTML、标签或注释。

示例（任务行格式）：

```markdown
- [ ] Validate swap opportunity numbers with Emma after the MBR #task #ideashell 📅 2026-10-28 ^ideashell-ba277130-68cc-4feb-975f-b4584f770217
```

**待办设置项**

| 设置 | 默认 | 说明 |
|---|---|---|
| Enable to-do import | 关 | 显示「Import to-dos」命令和下面的设置。 |
| Include in scheduled import | 关 | 定时导入时也导入待办。 |
| Task format | 每条待办一个 TaskNotes 文件 | 或选 Tasks emoji 格式的任务行。 |
| Task folder | `ideashell/Todos` | 任务文件：新任务所在文件夹。移走的文件仍会被更新。 |
| Open status / Done status | `open` / `done` | 任务文件：未完成、已完成对应的 status 值。 |
| Include time | 开 | 任务文件：把待办时间写在日期后面（`2026-10-28T09:00:00`）。任务行不带时间（Tasks 格式没有时间）。 |
| Target | 固定文件 | 任务行：写进一个文件，或写进待办日期当天的日记（文件夹和格式取「日记」设置）。没有日期的待办写进文件。 |
| To-dos file | `ideashell/Todos.md` | 任务行：固定文件路径。 |
| Heading | `## ideashell` | 任务行：新行加在这个标题下，没有会自动添加。 |
| Date field | Due | 待办日期写成截止日期（`📅`）还是计划日期（`⏳`）。 |
| Task tag | `task` | 每条任务都需要的标签：TaskNotes 的任务标签，或 Tasks 插件的 global filter。留空则不加。 |
| Extra tag | `ideashell` | 每条导入的待办额外加的标签。留空则不加。 |
| Import completed to-dos | 关 | 同时导入已完成的待办。之前导入过的任务无论如何都会同步完成状态。 |
| Two-way completion | 关 | 在 Obsidian 里完成任务时，也在闪念贝壳里标为完成。 |

## 安装与设置

1. 安装插件：第三方插件 → 搜索 **ideashell**；或用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加本仓库地址。
2. 打开闪念贝壳（网页或 App）→ **设置 → MCP**，复制你的 **API Key**（即 MCP 访问秘钥，和接 Claude / Cursor 用的是同一个）。
3. Obsidian → 设置 → **ideashell**：选择区域（国内 / 海外），粘贴秘钥，点 **Test** 确认连接正常。

## 使用方法

### 同步一篇笔记
打开笔记，`Cmd/Ctrl+P` 执行 **Sync current note**，或点左侧栏的贝壳图标，或在文件列表里右键该文件。第一次执行是新建，之后执行是更新。内容没变会提示 *already up to date*，不发请求。

### 同步一个文件夹或多个文件
右键文件夹 → **Sync folder to ideashell (N notes)**；或按住 Cmd/Ctrl 多选文件后右键 → **Sync N notes to ideashell**。过程中有进度提示，结束后汇总 `created / updated / unchanged / failed`。可以反复执行，没变化的笔记会被跳过。

### 发一段文字
选中文字 → 右键 → **Send selection to ideashell**。第一行作为标题。每次都会新建一条，不会记录到 frontmatter。

### 长期保持一批笔记同步
- 用 **Mark current note for sync** 给笔记加上 `ideashell: true`，和/或在设置的 *Folders to sync* 里填文件夹路径。
- **Sync all marked notes and sync folders** 一次把它们全部发出去。
- 想让已同步的笔记改完自动更新，打开 **Auto-sync synced notes**（有防抖，延迟可调）。

### 到了闪念贝壳是什么样
- **标题**：优先用 frontmatter 的 `title`，否则用文件名（超过 30 字会截断，这是闪念贝壳的限制）。
- **正文**：去掉 frontmatter 的 markdown 正文。`[[笔记|别名]]` 变成 `别名`；`![[photo.png]]` 在正文里变成 `(photo.png)`，图片本身作为附件挂在笔记上。（双链转换可在设置里关闭。）
- **标签**：`obsidian`（可改）+ frontmatter 标签 + 正文 `#标签`。
- **文件夹**：按 Obsidian 文件夹路径命名，没有就自动创建。vault 根目录下的笔记不进文件夹。
- **图片**：以笔记级附件（图集）形式挂载，不是内嵌在正文里。

## frontmatter 里的同步状态

同步成功后插件会往笔记的 frontmatter 写入这几个字段，靠它们来判断"更新"而不是"重建"：

```yaml
ideashell_id: "3ab8b88088673df9b7ea47f70d80cfca"   # 闪念贝壳里的笔记 id
ideashell_hash: "90f30068"                          # 正文 hash，没变就跳过
ideashell_synced: 2026-08-30T08:44:52.913Z
ideashell_url: https://…/boards/3ab8b8…              # 闪念贝壳里这条笔记的链接
ideashell_folder: ideashell-test                    # 上次放进的文件夹
ideashell_images: [ideashell-test/img/red.png]      # 已经挂上的图片（不会重发）
```

- 删掉 `ideashell_id`，下次同步会当新笔记创建。
- 如果你在闪念贝壳里把这条笔记删了，下次同步会报"note not found"——删掉 `ideashell_id` 再同步即可。
- 在 Obsidian 里复制一篇已同步的笔记，副本会带着同一个 `ideashell_id`，两篇会更新同一条笔记。记得把副本里的 id 删掉。

## 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| Region / Custom endpoint | 国内 | 你的账号所在的服务器。 |
| API Key | — | 闪念贝壳 API Key（MCP 访问秘钥）。 |
| Source tag | `obsidian` | 每条同步笔记附加的标签，留空则不加。 |
| Map folders | 开 | 按 Obsidian 文件夹路径放进同名文件夹。 |
| Folders to sync | — | *Sync all* 时包含的 vault 文件夹。 |
| Auto-sync synced notes | 关 | 已同步笔记改动后自动重发。 |
| Auto-sync delay | 10 秒 | 停止编辑多久后重发。 |
| Convert wikilinks to text | 开 | `[[笔记\|别名]]` → `别名`。 |

## 会发送什么、发到哪里

本插件**只**向你在设置里选择的闪念贝壳 MCP 地址发起网络请求
（国内 `https://api.ideashell.cn/ideashell/mcp`，海外 `https://api.ideashell.com/ideashell/mcp`，或自定义地址）。
发送的是**你主动选择同步的那些笔记**的标题、正文、标签、文件夹名和内嵌图片，用你的 API Key 鉴权。
导入会读取你的闪念贝壳笔记（`recent_notes`、`note_detail`）和待办（`todo_list`）并写入 vault。导入唯一会写回闪念贝壳的操作，是在打开「Two-way completion」时用 `todo_update` 把待办标为完成。
vault 里的其它内容不会被读取或上传，没有任何遥测。

需要闪念贝壳账号。API Key 的权限与你其它 MCP 客户端（Claude、Cursor 等）相同；如果泄露，去闪念贝壳里重置。

## 限制

- 单向同步，闪念贝壳里的修改不会拉回 Obsidian。
- 图片附件只增不减：从正文里删掉 `![[photo.png]]`，闪念贝壳里的图不会跟着删。非图片附件（PDF、音频等）不上传，正文里显示为 `(file.pdf)`。
- 在 Obsidian 里给文件夹改名，闪念贝壳会新建一个新名字的文件夹并把笔记挪过去，旧的（已空）文件夹保留，需要手动删。
- 标题超过 30 字会被截断（闪念贝壳限制）。
- 在 Obsidian 里删除笔记不会删除闪念贝壳里的笔记。
- `todo_list` 每次最多返回 200 条待办，且不支持分页。导入时未完成待办调用两次（最近及无日期的、所有有日期的），需要时已完成待办再调用两次；如果某次达到上限，导入结果里会提示。
- 待办在闪念贝壳里改了日期，已导入的任务不会搬家；任务行会留在最初写入的那篇日记里。
- 不支持重复待办：闪念贝壳的待办工具没有提供重复规则。
- 批量同步是串行的，并且会自动控制在闪念贝壳的频率限制之内（遇到 429 自动等待重试）；首次同步大量笔记需要一些时间。

## 开发

```bash
npm install
npm run dev     # 监听构建 → main.js
npm run build   # 类型检查 + 生产构建
```

把 `main.js`、`manifest.json`、`styles.css` 拷到 `<vault>/.obsidian/plugins/ideashell/`，重载 Obsidian。

## 许可

MIT
