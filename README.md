# CraftDesk · Minecraft 多服务器管理器

一个深色三栏布局的桌面端 Minecraft 服务器管理器。界面参考现代 AI 桌面客户端的
信息层级，重新组织为「图标栏 / 服务器列表 / 主工作区 / 右侧面板」，用于同时管理多个
Minecraft 服务端。

Electron + React + TypeScript，零运行时依赖（主进程只用 Node 内置模块）。

## 功能

**界面**
- 标题栏只有图标、名字和当前服务器 —— 没有标签页。这软件是「左边选服务器、
  主区域看它」的单任务结构，标签页既和左树重复，又让人以为可以同时盯着好几台
- 图标是 `build/icon.png`（打包用同一个，见 `package.json` 的 `build.win.icon`）；
  标题栏左上角用它缩出来的 `src/renderer/public/logo.png`
- **两侧栏宽度可以调**：鼠标移到左侧列表和右侧面板的分界线上就能拖，双击恢复默认；
  也可以在「设置 → 个性化」里精确填数值。窗口不够宽时两侧会自动收窄，
  保证中间工作区不会先被挤没
- **背景可以换成自己的图**：「设置 → 个性化」里选一张图片（png / jpg / webp / gif / bmp，
  32 MB 以内），铺满窗口；背景本身的不透明度和各层面板的不透明度分开调 ——
  想把图当水印就调低前者，想让界面更透就调低后者。改完立刻生效，不用重启

**服务器管理**
- **主页是通栏的服务器列表**：上面一块「快捷操作」（全部启动 / 全部停止 /
  刷新所有服务器 / 添加新服务器），下面一条条服务器行 —— 左边图标与状态，
  右边状态文字加两个按钮（启动停止、启动配置），点整行进控制台。
  通栏比卡片网格好扫：名字、端口、状态都对齐在同一列上
- **总览只列服务器，不列代理端**：代理端是整张网络的入口，和它的后端不是平级
  关系，平铺成一行行会让人以为它只是「又一台服务器」。它的位置在左树（那一组的根）
  和网络拓扑（星图正中），总览顶部只留一个入口提示
- 运行中的行会跟上端口、在线人数、PID、内存占用和已运行时长
- **服务器图标可以换**：点属性页那张头像（或工具栏服务器菜单 →「换服务器图标…」），
  可以选一个表情、两个字以内的文字、一个底色，或者直接用自己的图片。
  图片会复制进 CraftDesk 的配置目录，之后原图挪走、删掉都不影响
- **左侧列表是树状**：代理端作为入口挂在最上面，它的后端缩进排在下面，
  一眼能看出谁转发给谁；没被任何代理端引用的归到「独立服务器」
- **网络拓扑视图**：星图画出代理端与全部后端的连接，标注默认入口（try）、
  运行状态、转发配置是否正常，点节点直接跳到那台服务器的控制台
- 导入已有服务端目录，自动识别核心类型、Minecraft 版本、端口、MOTD、EULA 状态、世界存档
- **导入跨服网络**（单独一条路）：代理端不是「一台服务器」而是一组服务器的入口，
  所以选中代理端目录后，CraftDesk 会读出配置里的全部后端、在附近找出对应的目录，
  列成清单让用户勾选要导入哪些（已在列表的、只有地址的、目录不对的分别标出来）
- 自动识别嵌套布局：核心在 `server/` 子目录、启动脚本是中文名（MCDReforged 等）也能认出来
- **下载跨服网络**（单独的第四个入口）：直接下 Velocity / Waterfall / BungeeCord，
  不用自己去官网翻 jar。代理端的配置由 CraftDesk 生成 —— Velocity 用核心里
  自带的官方模板（`config-version` 一定对得上那个版本），BungeeCord / Waterfall
  用内置的最小 `config.yml`，端口就是你在界面上填的那个
- 支持代理端（**Velocity** / BungeeCord / Waterfall）：走专属的配置、日志与玩家事件解析
- 代理端有专属界面：编辑 velocity.toml、管理后端服务器列表，并**核对每个后端是否真的接上了代理端**
- 下载并新建服务器：Paper / Purpur / 原版 / Fabric / **Forge** / **NeoForge**，选版本一键安装
  - 下载完自动核对官方给的大小与 sha256，坏文件当场丢重来，不会留个打不开的 jar
  - **Forge / NeoForge 走官方安装器**：这两家不提供「下个 jar 就能跑」的核心，
    官方给的是安装器（要联网拉一两百 MB 运行库，进度实时显示），装完的启动入口是
    参数文件，之后按 `java @参数文件` 启动
  - 顺手生成 `start.bat`，服务器起不来时双击就能看到 Java 的原话
- **可以用 MCDReforged 托管**（外置辅助端）：勾一下就把核心装进 `server/` 子目录，
  根目录留 MCDR 自己的 config.yml 与 Python 插件目录，并自动选好 handler
  - 建服前会先验证 Python 环境：解释器在不在、够不够新（要 3.8+）、装没装 `mcdreforged`，
    缺哪一步就在界面里说明，并能直接用 pip 装上
  - 设置页有专门的 Python / MCDReforged 区块：列出每个解释器及其 mcdreforged 版本
- 一键启停、优雅停止（先发 `stop` 保存世界，30 秒无响应再强杀）、重启、异常退出自动重启
- 运行时显示实际监听端口与进程 PID（端口从日志里 `Listening on` / `Starting Minecraft server on` 取真实值）

**控制台**
- 实时日志，按 INFO / WARN / ERROR / 聊天分级着色
- 中文编码自动回退：先按 UTF-8 解，出现替换字符再按 GBK 解，避免中文 Windows 乱码
- 直接发送服务器指令，内置 list / tps / save-all 等快捷指令
- 日志筛选、只看错误、自动贴底滚动
- 自动解析在线玩家、最大人数、TPS、PID

**配置**
- `server.properties` 图形化编辑，120+ 项中文对照，布尔项开关、枚举项下拉
- 保留原文件注释与顺序，写回不会破坏格式
- 启动配置：Java 路径、内存、JVM 参数、程序参数、启动方式（jar / 脚本）

**下载扩展**
- 左侧「下载扩展」页，直接给当前选中的服务器装模组和插件
- **Modrinth**：搜索模组 / 插件，自动按该服务器的 MC 版本与加载器过滤，
  服务端不支持的会标红「仅客户端」；安装时可选版本
- **MCDReforged**：227 个插件的中文目录，可按标签筛选，
  装了会在安装前提示缺失的依赖
- 装到哪儿由服务器布局决定，MCDR 布局下三个目录互不混淆

**文件**
- 目录浏览、面包屑导航、内置文本编辑器（Ctrl+S 保存）
- 目录体积后台异步统计（world、mods 这些文件夹有多大一目了然），带时间预算与缓存
- 重命名、新建文件夹、删除到回收站、在资源管理器中显示

**玩家 / 扩展 / 配置 / 备份**
- 玩家列表：在线状态、OP、白名单、封禁，一键切换（同时改 JSON 并给运行中的服务器发指令）
- 扩展管理分四类，互不混淆：
  - **MCDR 插件**：`.mcdr` / `.pyz` / `.py` / 解包目录，读 `mcdreforged.plugin.json`
  - **代理插件**：Velocity 的 `velocity-plugin.json` / BungeeCord 的 `bungee.yml`
  - **服务端插件**：Bukkit 系 jar，读 `plugin.yml`
  - **模组**：Fabric / Forge jar，读 `fabric.mod.json` / `mods.toml`
  - 每类都显示启用状态：禁用的整行变暗 + 红色「已禁用」标签，可按启用状态筛选
  - 每类都能**单独禁用 / 启用**（改扩展名，文件留在原地）或**删除单个文件**
  - 同名 id 冲突会标出来（MCDR 会因此拒绝加载其中一个）
  - **前置关系一眼可见**：每个扩展列出它依赖谁、谁依赖它。
    缺失的前置标红（「服务器起不来」的头号原因）、被禁用的标橙、平台自带的淡化；
    点一下前置跳到那个扩展，点「关系」看完整的依赖与被依赖列表；
    顶部有问题汇总条，可以一键「只看有问题的」
  - 删除前会提醒有几个扩展依赖它，避免顺手删掉别人要用的库
  - **是否在服务端有效**：模组自己声明的生效范围直接标在行上 ——
    纯客户端模组（`environment: client`）标「仅客户端」（服务端会加载但不起作用），
    只在服务端生效的标「仅服务端」。顶部会给出「N 个模组只在客户端生效」的汇总，
    还有一排「仅客户端 / 仅服务端」筛选，专门用来找多余的模组
  - **关系星图**：以某个模组为中心的星图 —— 左半边是它的前置（红）、右半边是
    依赖它的（蓝）、外面一圈是这些模组各自的其它关系（灰），缺失的前置画成红点、
    被禁用的套一个橙圈。点节点换中心、拖拽平移、滚轮缩放，双击跳到列表里那一行
- 配置编辑，两处来源分开：
  - **MCDR 配置**：根目录 `config.yml` 与 `config/`（Python 插件的配置）
  - **服务端配置**：服务端目录 `config/`（模组的配置）
- 备份：整目录复制、列表、还原（还原前会把当前内容移到 `.before-restore-*` 兜底）
- **删除服务器**分两种程度，都要二次确认：
  - **只从列表移除**：磁盘上一个字节都不动，之后还能重新导入
  - **连服务器目录一起删除**：整台服务器移入回收站，必须把服务器名字原样打对才执行

## 运行

```bash
npm install
npm run dev        # 开发模式
npm run build      # 构建到 out/
npm start          # 运行构建产物
npm run dist       # 打包成单文件便携版 exe（release/CraftDesk-1.0.0-portable.exe，约 65 MiB）
npm run dist:dir   # 只出免安装目录（release/win-unpacked），排查打包问题用
```

### 换应用图标

`build/icon.png` 是 exe 与窗口的图标（≥256×256 的方形 PNG）。标题栏左上角那张是
另一份文件（缩小过的，省体积），换了图标要一起重做 —— 否则 exe 是新图标、
界面里还是旧的：

```bash
python scripts/make-logo.py build/icon.png src/renderer/public/logo.png 256
```

脚本只用标准库（PNG 解码 + 面积平均缩放 + 重新编码），不为一张缩略图引入图像库。

### 体积是怎么压下来的

| 手段 | 效果 |
|---|---|
| `compression: "maximum"` | 最终 exe 用 LZMA 压到最狠（代价是打包慢一点） |
| `electronLanguages: ["zh-CN", "en-US"]` | Electron 自带 55 个语言包（41 MB），只留中文和英文 → 解压后 270 MB → 231 MB |
| `files` 只列 `out/**`、`build/icon.png`、`package.json` | 源码、测试脚本、脚本目录都不进包 |
| asar 打包 | 一万多个小文件合成一个，既省体积也省启动时的文件系统操作 |

exe 从 71.6 MiB 降到 65.2 MiB。再往下压就得动 Electron 运行时的 DLL
（`vk_swiftshader.dll`、`libGLESv2.dll` 这些软件渲染兜底），
删了在没装显卡驱动的机器上会白屏，不值得。

### 打包出来的 exe

单文件、双击即用、不用安装。第一次运行会在 **exe 旁边**建一个 `data\` 目录，
配置（`craftdesk.json`）、服务器图标都在里面 —— 整个文件夹拷到 U 盘就能带走，
换台机器打开还是同一份服务器列表。

- 已经有配置文件就直接读，不会被默认值覆盖（`data\` 里有东西就照旧用）
- 放在 `C:\Program Files` 这类没有写权限的地方时，会自动退回系统的
  `%APPDATA%\CraftDesk`，不会因为一个路径选择导致程序起不来
- 「设置 → 运行环境」里会写明当前配置放在哪、是不是便携模式
- 便携版不申请管理员权限（`requestExecutionLevel: user`），打开时不会弹 UAC
- 单文件 65 MiB（Electron 运行时占了绝大部分；语言包只留中英两份）

## 测试

两件事分别有各自的入口，不用记参数：

```bash
npm run app              # 起一个实例来试（默认用你平时的配置）
npm run app:test         # 起一个干净实例（配置在 tmp/test-userdata，不碰真实服务器列表）
npm run app:stop         # 停掉正在跑的实例
npm test                 # 跑离线测试（几秒到半分钟）
npm run test:all         # 连联网与耗时的重活一起跑
```

**`npm run app`（`scripts/run-app.mjs`）** 把手工起实例踩过的坑都收进去了：

- 单实例锁：同一个配置目录只允许一个实例，前一个不退新的会静默退出 → 启动前先停掉，并等它真的退干净
- `ELECTRON_RUN_AS_NODE`：有的终端会设这个变量，Electron 会当 node 跑，窗口根本不出现 → 启动前清掉
- 调试端口：固定 9222 并检查是否被占，起来之后直接打印可用的 `ui-drive` 命令
- `--isolated` 用一份独立配置（`tmp/test-userdata`），可以放心乱点、乱删服务器，不影响你平时的列表
- `--clean` 清理被强杀留下的孤儿服务端进程（只认本项目 tmp 目录下的 java / python，不会误伤你在跑的服务端）

```
--dev        开发模式（改代码自动重载）
--isolated   干净的测试配置目录      --fresh    先把测试目录删掉（配合 --isolated）
--no-build   跳过构建               --port n   换调试端口（默认 9222）
--stop       只停实例               --clean    停实例 + 清残留进程
```

**`npm test`（`scripts/test-all.mjs`）** 按代价分组跑那些 `test-*.ts`：

| 组 | 内容 |
|---|---|
| `fast`（默认） | 离线、几秒到半分钟：依赖关系 / 启动脚本 / 删除守门 / 转发判定 / 界面尺寸 / 服务器图标 / 核心目录 / 便携数据目录 / 代理端配置 / MCDR |
| `net` | 要联网：Forge 版本表、下载器、扩展源、代理端下载源、下载源图标 |
| `slow` | 几分钟：真装一遍 NeoForge、真开一台 MCDR |
| `dir` | 给一个服务器目录才有意义：识别 / 布局 / 扩展扫描 |

```bash
npm test -- --only mcdr                          # 只跑名字里带 mcdr 的
npm test -- --dir "D:/你的/服务端目录"             # 加上对目录跑的
```

联网的那几组跑之前会先做一次站点自检（GitHub / Modrinth / Mojang / PaperMC），
失败时也会区分「连不上站点」和「测试真的没过」—— 这两种情况的处理方式完全不同。

## 技术要点

### 中文日志解码

Minecraft 服务端在中文 Windows 上可能输出 GBK，也可能输出 UTF-8。启动时注入
`-Dstdout.encoding=UTF-8` 让 Java 19+ 统一输出 UTF-8；对老版本 Java，`LineDecoder`
逐行尝试严格 UTF-8 解码，失败再回退 GBK。

### 进程管理

- Windows 下用 `taskkill /T /F` 结束整棵进程树，避免 `start.bat` 拉起的子进程变成孤儿
- 每 5 秒用一次 PowerShell 批量查询所有服务端进程的内存占用，没有服务运行时自动停止轮询
- 退出应用时确保所有子进程被回收，不留后台 Java

### 渲染性能

日志可能每秒几十行。渲染进程侧用 `requestAnimationFrame` 把日志合并成每帧一次
`setState`，避免高频重渲染把界面拖垮。渲染层保留 2000 行，主进程保留更多。

### 界面尺寸与背景

宽度、不透明度这些「调一下看看」的东西，取值规则全在 `src/renderer/src/uiPrefs.ts`
里，是一组纯函数，界面只负责传值。

- **宽度要过两道关**：单侧的上下限（拖到负数、拖出屏幕都会坏），
  以及窗口的总空间。第二道容易被忽略 —— 两侧都拖宽之后，中间工作区就没了，
  日志一行显示不下几个字。`fitWidths()` 会在空间不够时先收右侧面板、再收左侧列表
  （列表是「去哪台服务器」的入口，挤到看不清更碍事），但各自不低于最小值。
  窗口最小 1080px（`BrowserWindow.minWidth`），两条最小值加上工作区正好放得下
- **拖拽时先写在本地状态，松手才落盘**：每帧写配置会触发一次 IPC 加一次去抖落盘，手感发涩
- **背景图存的是路径，不是 data URL**：图片内容由主进程 `app:readImage` 读成 data URL
  交给渲染层。存 base64 的话配置文件会从几 KB 涨到几 MB；而页面 CSP 是
  `img-src 'self' data:`，直接给 CSS 一个 `file://` 路径会被拦掉
- **背景图读不出来时要说清楚**：文件被移动或删掉之后，设置里那行文件名还在，
  用户会以为是透明度调坏了。`App` 把失败原因记进 store，设置页里直接写出来，
  同时按「没有背景」显示
- **面板透明了，弹窗不透明**：`.app.has-bg` 只把 `--bg-*` 换成半透明版本，
  `.modal` 保持实色 —— 弹窗上的字要是也透了，确认按钮上的字就看不清了
- **工具栏按工作区宽度让位，不是按窗口宽度**：窗口 1440、两侧都拖到最大时，
  工作区只剩 400 出头，光标在窗口大小上的 `@media` 完全看不出来。
  所以 `.main` 是 CSS 容器（`container-type: inline-size`），
  工作区一窄就先收起「目录名」这个快捷方式，再收起「类型版本」，
  保证「启动 / 停止」永远在可视区里；设置页的表单同理，窄到一定程度会把
  标签换到控件上面一行

### 代理端下载与「配置从哪来」

代理端和普通服务端有两处根本不同，处理方式也就不同：

- **没有 EULA、没有 server.properties**。端口、MOTD、后端列表都写在它自己的
  配置文件里。所以「下载跨服网络」是**单独一条路**（添加服务器里的第四张卡片），
  不和「下载并新建服务器」混在一起 —— 混在一起用户会以为自己在装一台普通服务端，
  装完发现没有世界、指令也不一样。
- **配置得先写一份出来**，否则第一次启动监听的是默认端口（Velocity 25577），
  用户填的端口没生效。

配置的来源分三种，按可靠性排：

| 代理端 | 配置从哪来 |
|---|---|
| Velocity | **核心 jar 里自带的 `default-velocity.toml`**（用 `zip.ts` 取出来，只改 `bind` / `motd` / `online-mode`） |
| Waterfall / BungeeCord | jar 里没有任何 yml（默认配置写在代码里），用内置的最小 `config.yml` |
| 取不到官方模板时 | 内置的兜底 `velocity.toml`，`config-version` 故意写旧 —— 迁移是单向的，旧版本号只会让它补键，写新了它会拒绝启动 |

几个踩过的坑：

- **改了值但不能丢注释**：官方模板里有 90 多行注释，整份重写会把它们全冲掉。
  按行改，只替换要改的那几行；缺键时插到第一个 `[section]` 之前 ——
  写到段后面就变成那个段的键了，Velocity 会解析成完全不同的意思
- **MOTD 里的引号要转义**：用户填个 `"` 或 `\` 就把 TOML / YAML 写坏了，
  而报错是解析器的原话，用户根本看不出是自己填的引号干的
- **Paper 的 v2 接口已经 sunset**（返回 `{"ok":false,"error":"sunset"}`），
  Velocity / Waterfall 走 fill v3；构建列表里混着一堆 `module:*` 的碎片
  （几 KB），只认 `server:default` 才不会下错
- **BungeeCord 没有版本号**，只有构建号（`2100` 这种）。这个数字**不能**拿去套
  Minecraft 的版本规则 —— 会被当成「26 之后的版本」而要求 Java 25。所以
  `proxyJavaMajor()` 单独算：Velocity / BungeeCord 一律 17，Waterfall 跟着
  它对应的 MC 版本走
- 地址优先用官方 Jenkins（`ci.md-5.net`），SpigotMC 的 Jenkins 当备选，
  一边抽风还能下下来

### 下载源的图标为什么要绕一圈

下载扩展页那些模组图标（Modrinth / Hangar / MCDR 目录给的 `icon_url`）**不能**
直接写进 `<img src>`：页面的 CSP 是 `img-src 'self' data:`，外链图片会被拦掉。
表现是**一排破图** —— 用户看到的是「图标加载不出来」，实际浏览器连请求都没发。

所以统一走主进程抓一次、转成 data URL（`app:fetchImage`）：

- **CSP 不松**：放开 `img-src https:` 等于允许页面往任意地址发请求，
  谁在看你、看你哪一页，都成了外部站点能收集的信息
- **地址白名单**：只接受 https（`file:` / `data:` / `javascript:` 一律拒绝）——
  这些 url 来自外部接口，不能顺着往下走
- **顺手限制体积**：超过 5 MB 直接跳过，不是图片的（返回 JSON 的地址）当场拒绝
- **主进程侧做 LRU 缓存**（120 张）：同一张图翻来覆去只下一次，翻页也不重复抓
- **抓不到就显示占位方块**，不再是一个破图：网络抖动、站点 404、图标本身没了，
  界面都要保持体面

### 核心目录怎么认（以及为什么它最关键）

`resolveLayout()` 给出的「核心目录」决定了 `mods/`、`plugins/`、`server.properties`、
`server.properties`、`ops.json` 全都在哪找。认错一次，表现是**模组列表空空如也**，
而用户看不出错在哪 —— 只会以为这软件不支持整合包。

规则：

1. 根目录有 jar / 有加载器标记 / 有 `server.properties` / 有 `eula.txt`
   → 核心就是根目录，**不再往子目录找**
2. 否则才往下一层找，而且要求那个子目录像服务端核心：有加载器标记，
   或者最高分的 jar 真的是核心（`server.jar` / `paper-*.jar` / `forge-*.jar`……）
3. `mods` / `plugins` / `config` / `world` / `libraries` / `logs` 这类**内容目录**
   永远不当核心（名单在 `src/shared/contentDirs.ts`）

踩过的坑：Forge / NeoForge **1.17 以后根目录根本没有 jar**（启动入口是
`libraries/` 下的参数文件），于是老规则「谁有 jar 谁是核心」把
一个装着 245 个模组的 `mods/` 认成了核心目录 —— `mods/` 于是变成
「核心目录下的 mods」（不存在），整台服务器一个模组都读不到。

配置里已经存下的错误值也会被忽略：`resolveLayout()` 见到 `coreDir` 是内容目录名就
当成没写、走自动探测。已经导入过的服务器不用重新导入一遍。

### 服务器图标存在哪

图标是一个短字符串，存在服务器配置里（`ServerConfig.icon`），三种形态：

| 值 | 含义 |
|---|---|
| `''` | 用服务器名字的缩写（默认） |
| `text:⛏️` | 一个字或表情 |
| `file:abc-123.png` | 用户自己的图片，文件在配置目录的 `icons/` 下 |

- **图片是复制进来的，不是记原路径**：用户选完图片之后把原图挪走、删掉、改名都很常见，
  记原路径的话图标就变成一个破图。复制进 `icons/` 之后它跟着配置走，
  换台机器拷一份配置过去也还在
- **文件名是 `<服务器id>.<扩展名>`**，主进程只认文件名、自己拼目录，
  并且拒绝任何带分隔符或 `..` 的名字（配置是能被手改的，
  不能让它变成「读任意本地文件」的入口）
- **一台服务器只留一个图标文件**：换图时新的复制成功之后才删旧的，
  否则复制失败会把原图标也一起弄丢。换成表情、文字或缩写时，
  那个已经没人引用的图片文件同样会被清掉
- **长度按码点算**：`🌲` 在 JS 里是 2 个 UTF-16 码元，用 `.length` 判断
  「最多两个字」会把它判成超长而截断
- **表情要带变体选择符（U+FE0F）**：`⛏ ⚔ ❄ ⚙` 这些字符默认是文字形态，
  不带选择符会被画成细线，放在彩色头像里像是没渲染出来
- 同一张图会在左树、工具栏、总览、属性页同时出现，所以按文件名缓存一次
  （`iconCache.ts`），刚导入的图直接塞进缓存，省掉一次往返

### 服务端识别与目录布局

按标记文件判断加载器（`fabric-server-launcher.properties`、`libraries/net/...`），
比看 jar 文件名可靠。根目录没有核心 jar 时，会再往常见的子目录（`server/`、`核心/` 等）
找一层，这样 MCDReforged 这类「配置在外、服务端在 `server/` 里」的布局也能正确导入。

脚本名按评分排序，识别中文的「启动 / 开服 / 运行」，同时把「一键安装 / 一键更新」
这类安装器排在后面，避免选错入口。

关键点是**「服务器目录」不等于「Minecraft 服务端目录」**。MCDReforged 这类包装层
把服务端放在 `server/` 下面，根目录只有它自己的插件和配置。所以
`server.properties`、`ops.json`、`whitelist.json`、`mods/`、`config/` 全都要
跟着核心目录走 —— 找错地方就会什么都读不到。`layout.ts` 负责统一解析这件事：

```
某台服务器/                 ← 服务器根目录（备份的起点）
├── config.yml              ← MCDR 主配置，含真正的启动命令
├── plugins/*.mcdr          ← MCDR 的 Python 插件
├── config/                 ← MCDR 插件配置
└── server/                 ← 核心目录
    ├── server.properties   ← 服务端配置
    ├── ops.json            ← 玩家数据
    ├── mods/               ← 模组
    └── config/             ← 模组配置
```

### MCDR 的内存设置

MCDR 用自己的 `config.yml` 里的 `start_command` 启动服务端，CraftDesk 拼的
`-Xms/-Xmx` 根本传不进去。界面会解析出实际命令里的内存值并明确提示，
否则用户改完以为生效了，跑的还是原来那份。这也是启动配置页会出现黄色提示条的原因。

### 跨服网络为什么单独一条导入路径

代理端（Velocity / BungeeCord）目录里没有世界、没有 EULA、没有 server.properties ——
它是一组服务器的入口，`[servers]` 里每一行都指向另一个目录。按普通服务端那样导入，
只能得到一台「看起来什么都没配好」的代理端，而它身后那八台后端得用户自己挨个找、挨个导。

所以添加入口里它是独立的一张卡：选中代理端目录 → 读出配置里的后端 → **在磁盘上把它们找回来** →
列成带勾选框的清单（哪些已在列表、哪些可以导入、哪些只有地址）。找目录靠两条线：

| 依据 | 说明 |
|---|---|
| **端口**（主） | 目录里 `server.properties` 的 `server-port` 和配置里的端口对上就是它。别名可以是 `mirror`，目录名却可能完全不搭边 —— 名字对不上，但端口对得上 |
| **名字**（辅） | 别名与目录名互相包含（`lobby` ↔ `Lobby`）。只在端口对不上时使用，界面上会标成「按名字猜的」 |

搜索范围是代理端所在目录的父目录往下两层（最多 60 个候选），每个候选只读一次
`server.properties` —— 完整识别一个目录要数体积，十几台 12 GB 的服务器会把界面卡住，
所以探测时一律 `skipSize`。

代理端与后端的转发关系不用手动登记：拓扑视图按端口自动连线，导完就能在星图里看到整张网。

### 怎么判断一个模组在服务端有没有用

服务端的 `mods/` 里经常躺着几十个纯客户端模组（小地图、光影、界面美化……），
它们会被加载但什么也不做。Fabric 在 `fabric.mod.json` 里明写了这件事：

```json
{ "id": "sodium", "environment": "client" }   // 纯客户端
{ "id": "lithium", "environment": "*" }       // 两边都要（也是默认值）
{ "id": "servux", "environment": "server" }   // 只在服务端
```

| 类型 | 来源 | 判定 |
|---|---|---|
| Fabric / Quilt 模组 | `environment` | 读得到就是准的；没写按默认的 `*` 算「两边都要」 |
| Forge / NeoForge 模组 | 没有这个字段 | 一律 unknown，**不猜**（分侧是运行期用 `Dist` 判的，元数据里没有） |
| 服务端插件 / MCDR 插件 / 代理插件 | —— | 天然是服务端侧 |

界面上只给「反常」的两种打标签：纯客户端的标「仅客户端」、只在服务端的标「仅服务端」，
两边都要的不打扰。**顺带说清楚它不是「垃圾」**：要把 `mods/` 同步给客户端的那种服
目录，纯客户端模组是有意留着的 —— 提示条里写了这句，免得用户照着删。

### 关系星图怎么画的

点「扩展」面板右上角的星图图标，或者任意模组的「关系 → 在星图里看」，
就把依赖关系铺成一张以它为中心的星图。左边是前置、右边是依赖它的，
一眼能看出一个模组牵扯到谁。

布局是**确定性**的（`graph.ts` 里全是纯计算，没有力导向）：

- **不用力导向**是有意的：那样每帧迭代、节点会飘，同一份数据两次打开位置还不一样。
  确定性的布局打开就稳定，也才能在测试里断言「没有 NaN、都在画布内、上限真的生效」
- **游泳道**：一圈里最多 18 个占一条道，多的往下一条道放（半径 +74）。
  Fabric API 那 74 个「依赖它的」如果都放在同一个半径上，名字会叠成一条弧
- **缺失的前置也画**：没有对应文件的依赖画成一个红点，虚线描边、点不动 ——
  「谁缺什么」正是这张图最该指出来的东西
- 手写的 SVG，没有引第三方图库：项目零运行时依赖，几百个节点直接渲染就够快

### 依赖关系是怎么算出来的

五种加载器各写各的，先得把「它要什么」从各自的描述文件里抠出来：

| 加载器 | 描述文件 | 硬前置 | 软前置 | 其它 |
|---|---|---|---|---|
| Fabric | `fabric.mod.json` | `depends` | `recommends` / `suggests` | `provides` / `breaks` |
| Forge / NeoForge | `META-INF/mods.toml` | `[[dependencies.x]]` 且 `mandatory=true` | `mandatory=false` | `versionRange` |
| Bukkit 系 | `plugin.yml` | `depend` | `softdepend` / `loadbefore` | `provides` |
| BungeeCord | `bungee.yml` | `depends` | `softDepends` | |
| Velocity | `velocity-plugin.json` | `dependencies[].optional=false` | `optional=true` | |
| MCDReforged | `mcdreforged.plugin.json` | `dependencies`（剔除 `mcdreforged`） | | 版本要求 |

然后 `relations.ts` 把「谁提供什么」和「谁要谁」对上，得出三种状态：

- **missing**：没有任何文件提供这个 id —— 标红，这是服务器起不来最常见的原因
- **disabled**：提供了，但那个文件被禁用了（`.disabled`）—— 标橙，改扩展名就能修
- **platform**：`minecraft` / `fabricloader` / `forge` / `java` 这类平台自带的，不算缺失。
  少了这条判定，**每一个**模组都会因为依赖 `minecraft` 而报「缺前置」

两个必须处理的现实情况，都是拿真实目录跑出来的：

1. **一个 jar 里装几十个模组**。Fabric API 把 44 个小模组放在 `META-INF/jars/*.jar`，
   模组依赖的 `fabric-api-base` 这类 id 由它提供。只读最外层描述文件的话，
   70 多个模组会被误报成「缺 fabric-api-base」。所以嵌套 jar 要进去读一遍
   （Forge 那边对应 `META-INF/jarjar/metadata.json`），拿到的 id 全算这个 jar 提供的。
2. **描述文件不那么标准**。`JSON.parse` 很严，而模组描述文件常带 UTF-8 BOM，
   或者字符串里有裸换行 —— Fabric Loader 用宽容模式解析，所以模组在游戏里跑得好好的，
   严格解析却直接抛异常，结果是这个模组在依赖图里变成读不出 id 的空条目。
   解析前先去掉 BOM、把字符串里的控制字符转义掉，再不行才放弃。

文件读不动（zip 被截断）和「读不出 id」是两回事：前者 Java 也读不了，
标成「文件损坏」并建议重新下载，而不是显示成一个空条目。

### 用 MCDReforged 建服时踩到的三件事

**一、必须跑一次 `mcdreforged init`。** 少它一个 `permission.yml`，MCDR 启动时
会打印 `Looks like MCDR is not initialized at current directory` 然后直接退出——
界面上只看到一句「启动失败」，日志里也没有堆栈。所以建服流程里显式跑一次官方
init，让它按自己版本生成 permission.yml 和完整的 config.yml 模板，缺文件时
再由 CraftDesk 补一份兜底模板。

**二、改配置，而不是整份替换。** init 留下的 config.yml 是当前 MCDR 版本的
全量模板（60+ 个选项）。整份换成自己手写的那份，新版每加一个选项启动时就会刷
一排 `Option 'xxx' missing, use default value`；只改 `start_command` /
`handler` / `working_directory` / `language` 这四项，其余留着，配置就跟着用户
装的 MCDR 版本走。

**三、控制台要降级成简易的。** MCDR 默认用 prompt_toolkit 做交互控制台，它需要
一个真正的 Windows 控制台。CraftDesk 是从界面进程里把它拉起来的，那个进程没有
控制台，于是 `NoConsoleScreenBufferError` 一路刷屏。生成配置时写
`advanced_console: false` 走简易控制台，stdin 照样能收发指令——控制台面板的
`list` / `stop` 都是这么进去的。

### Forge / NeoForge 为什么不是「下个 jar」

这两家官方只给安装器：`java -jar forge-<mc>-<版本>-installer.jar --installServer <目录>`。
安装器要联网拉一两百 MB 运行库（第一次几分钟很正常，界面里实时显示它的输出），
装完的启动入口是一个**参数文件**：

```
libraries/net/neoforged/neoforge/21.1.252/win_args.txt
```

所以 1.17 以后的 Forge / NeoForge 是 `java @win_args.txt` 启动，不是 `-jar`。
CraftDesk 在安装后扫描两种 maven 布局找到它，存进配置的 `launchArgs`，
启动、启动脚本、导入识别、MCDR 的 `start_command` 四条路径都用它。
更早的版本没有参数文件，安装器直接产出通用 jar，那就照旧 `-jar`。

版本表分别来自 Forge 的 `promotions_slim.json`（每个 MC 版本给推荐版 / 最新版）
和 NeoForge 的 maven 版本列表（按 `21.1` 这样的前缀分组映射回 MC 版本）。

### 代理端不是 Minecraft 服务端

Velocity / BungeeCord / Waterfall 只做转发，没有世界、没有 EULA、没有
`server.properties`，硬套服务端那套只会显示一堆空字段。代码里按这几处区别对待：

| | 服务端 | 代理端 |
|---|---|---|
| 配置 | `server.properties` | `velocity.toml` / `config.yml` |
| 日志格式 | `[时间] [线程/级别]: 正文` | `[时间] [线程/级别] [logger]: 正文` |
| 玩家进服 | `Steve joined the game` | `[connected player] Steve (...)` has connected |
| 启动完成 | `Done (12.3s)! For help, type "help"` | `Done (0.83s)!` |
| 启动参数 | 需要 `nogui` | 不接受 `nogui` |
| 插件 | `plugin.yml` | `velocity-plugin.json` / `bungee.yml` |

有个容易踩的坑：代理端日志里 `[server connection] Steve -> survival has connected`
是**玩家在后端服务器之间切换**，不是进出服。只匹配 `[connected player]` 前缀，
否则在线人数会来回抖。

### 同端口的服务器

同一端口被多个服务器配上时，同时启动只有一个能绑上端口，另一个必然启动失败。
所以：

- **拓扑与左树里并列显示**，都打上红色「同端口」标签——它们是同级关系，
  但互斥，不能同时跑
- **启动前就拦下来**：检查该端口上是否已有别的服务器在跑，直接告诉你是被谁占了，
  而不是等 Java 报 `FAILED TO BIND TO PORT` 才发现

### 人数直接问服务端，不靠数日志

日志里数人头是「从 CraftDesk 接管之后」的变化量：中途才启动的服务器、
崩溃前没刷出来的离开行、插件方式进服的玩家，都会让这个数字慢慢偏掉——
表现就是**客户端服务器列表里明明写着 1/99999，界面里却是 0**。

所以现在走 **Server List Ping**（就是客户端刷服务器列表用的那条协议）：
握手 → 请求状态 → 服务端回一个 JSON，里面带着它自己报的 `players.online`
和 `players.max`。同一个来源，两边必然一致。

- 每 6 秒问一次（只在本地回环上，3~7ms）；问不到就退回日志数出来的值，不清零
- 上限也跟着 ping 走：`max-players` 不一定是 server.properties 里那个值，
  代理端用 `show-max-players`，插件也可能改写
- 名单（`players.sample`）只在「数量完整且看着像用户名」时采信：插件常往里塞
  广告词，而且多数服务端只给前 12 个名字

### 不是 CraftDesk 启动的服务器

手动双击 `start.bat`、或者 MCDR 自己拉起来的服务端，进程不归 CraftDesk 管，
但它确实在给玩家服务。之前这种情况界面显示「已停止、0 人」，而客户端里
有人在玩——同一个人，两个软件两套说法。

现在 ping 顺带把这件事也认出来了：**端口上有服务端在响应，但我们的进程表里
没有它**，就会标成「外部启动」并且照常显示真实人数（主页、左树、星图上都有）。
同一个端口被多台服务器声明时（比如测试服和生存服都在 25565），
用 ping 回来的版本串 / MOTD 去对，只能对上唯一一台才认领，对不上就谁也不认。

从外部启动的服务上点「启动」会被拦下，并说明端口上已经有东西在跑——
比让它启动到一半报 `FAILED TO BIND TO PORT` 强。

### 在线人数不能简单相加

玩家是从代理端进来的，代理端记一次「XX 已连接」，他被转到某个后端后，
后端又记一次「XX 加入了游戏」。把两边相加等于把同一个人算两遍。

所以网络在线人数按这个规则算：**代理端在跑就以它为准**；代理端没跑
（玩家可能各自直连后端）才退回去数后端。人数上限取代理端
`velocity.toml` 的 `show-max-players`——后端 `server.properties` 里的
`max-players` 在代理架构下没有意义，玩家看到的列表上限由代理端决定。

### 代理端和后端不是平级关系

代理端是玩家唯一的入口，后端只是被转发的下游，平铺在一个列表里会把这个结构藏起来。
`topology.ts` 解析出从属关系：遍历每个代理端的 `[servers]`，按**端口**
和 CraftDesk 托管的服务器对上号，没对上的画成虚节点（磁盘上确实存在、
只是没导入，不能假装它不存在）。

界面用两处表达这个结构：
- **左树**用了缩进 + 连接线，代理端是父节点，后端是子节点
- **拓扑视图**是星图：SVG 画连线，节点用 HTML 绝对定位叠在上面
  （这样节点能直接是可点按钮，样式也不用跟 SVG 较劲）

### 什么才算「后端」

只按端口把 `[servers]` 和托管的服务器对上号是不够的。同一台机器上常常有
两台服务器配着同一个端口（比如测试服和生存服都在 25565），端口对上号不等于
它就是那条转发关系的后端 —— **还得看它有没有接转发的手段**：

| 转发方式 | 判据 |
|---|---|
| FabricProxy / FabricProxy-Lite（Fabric 系） | `mods/` 里有这个模组 |
| Paper 原生 Velocity 转发 | `config/paper-global.yml` 里 `proxies.velocity.enabled: true` |
| BungeeCord 传统转发 | `spigot.yml` 里 `settings.bungeecord: true` |

三种都要认：只看模组的话，最常见的「Paper 后端 + 原生转发」会被判成不是后端，
它反而会从代理端子树里掉出去。

于是没装转发模组的那台就不会挂在代理端下面了 —— 它本来就接不了转发，
挂上去再打个红色「无转发」标签，读起来像是代理端配错了。现在它照常算
**独立服务器**；代理端界面里的后端核对仍然会指出「这个端口上的服务端
没装转发模组」，该说的信息一个字都没少，只是不再把不相干的服务器拉进那棵树。

同一个端口有多台候选时，后端核对也改成优先挑真的能接转发的那台 ——
之前是按遍历顺序「后来者覆盖」，核对的是谁全看运气。

### 后端是否真的接上了代理端

只把服务器写进 `[servers]` 是不够的——后端还必须装 `FabricProxy` 或
`FabricProxy-Lite`，玩家才能拿到真实 IP 和正确 UUID。所以代理端界面会做两步核对：

1. **在不在 `[servers]` 里**：解析 velocity.toml 的服务器列表，按端口和 CraftDesk
   托管的服务器对上号
2. **转发配置对不对**：找到后端 `mods/` 里的转发模组，读它的配置
   （`config/FabricProxy-Lite.toml` 或 `config/FabricProxy/config.toml`），核对：

   | 检查 | 不通过会怎样 |
   |---|---|
   | `secret` 与代理端 `forwarding.secret` 一致 | 玩家被拒绝登录 |
   | 代理端 `player-info-forwarding-mode = modern` | 模组拿不到转发数据 |
   | 后端 `online-mode` 与 `hackOnlineMode` 自洽 | 玩家因验证失败被踢 |

   没装转发模组、密钥不符这类问题会直接标红并说明后果。

### 扩展下载的数据来源

五个源统一成一份 `RegistryHit` / `RegistryVersion` 形状，界面只认这一份，
加新源不用改界面。各源的实际可用性都实测过：

**Modrinth** 有正式的 v2 API，直接用：`/v2/search` 配 facets 过滤
（`project_type` / `versions` / `categories` 分别对应类型、游戏版本、加载器），
`/v2/project/{id}/version` 拿可用版本。

**Hangar** 官方 v1 API：`/projects?q=&platform=PAPER&version=1.21.11` 搜索，
`/projects/{owner}/{slug}/versions` 取版本，下载是 `hangarcdn.papermc.io` 直链。
一个坑：`sort=-relevance` 不是合法值会直接 400，有搜索词时它本来就按相关度排。

**SpigotMC** 没有官方 API，走第三方 Spiget。实测 `/resources/{id}/download`
会 302 跳到真实地址：`external`（托管在 GitHub 等）的能下，Spigot 自托管的
会撞上 Cloudflare 的 `Just a moment...` 403。所以界面按 `external` 区分，
不能装的就禁用按钮并提示去手动下载。

**CurseForge** 官方 API 不带 `x-api-key` 一律 403（实测过），
所以让用户自己去 console.curseforge.com 免费申请，填进设置。

**MCDReforged 没有公开 API**，这点查证过：
- `/api/plugins`、`/plugins.json` 返回的都是 Next.js 的 SSR 回退页，不是 JSON
- 列表页只在服务端渲染第一页（15 个），翻页参数是纯客户端的，`?page=N` 拿到的还是同一页
- JS chunk 里也没有任何接口地址

最后用的是官方 **PluginCatalogue 仓库的 `catalogue` 分支**构建出来的
`full-zh_cn.md`——一份 958 KB 的文件就是全部插件，带中文名、中文描述、
已翻译的标签、依赖关系，以及**每个版本的 .mcdr 直链**。
一个请求拿全，还绕开了 GitHub API 每小时 60 次的限流。

解析这个 markdown 时有两个坑：
- README 正文里也有 `## 小标题`，只按 `##` 切块会多出 60 个假插件。
  判据是块内必须声明了 `- 插件 ID:` 且与标题一致。
- 少数插件（如 MirrorServerReforged）在目录里没有「下载」小节，
  这时才回退去查它自己的 GitHub Releases。

### 删除为什么写了这么多代码

删除是这套东西里唯一不可逆的操作，所以「点一下弹个确认框」是不够的：

**闸门有三道，而且都不在同一个地方。** 界面上的对话框只负责把代价讲清楚
（两个选项各会失去什么、这个目录有多大）；「连目录一起删」的确认按钮要先把
服务器名字打对才解锁——再多点一次「确定」是肌肉记忆，打出名字必须过脑子。
但界面是界面，真正的执行点在主进程，所以主进程会**再核对一次这个名字**，
对不上就当没点过。

**不猜，宁可拒绝。** `removal.ts` 会把明显不该删的目标挡回去：盘符根目录、
只挂在盘根下一层的目录（可能是一堆服务器的父目录）、用户主目录，
以及装着 CraftDesk 自己数据目录的那一层——删了它等于把服务器列表一起删了。

**说话要算数。** 整台服务器只走回收站，`fs.rm` 兜底在这里被**故意去掉**了：
界面承诺的是「能反悔」，回收站失败就说明这个承诺兑现不了，那就报错让用户手动处理，
总好过嘴上说可恢复、实际永久删掉。单个模组/插件文件那条路保留了兜底（回收站
不可用时直接删），但接口会把实际用的方式返回给界面，提示语跟着变——
「已移到回收站」和「已删除（回收站不可用，是永久删除）」不是同一句话。

删除扩展的通道还自己认路：界面传进来的只是一个相对路径字符串，
`resolveExtensionFile` 要求它确实落在布局解析出来的 `plugins/`、`mods/`、
MCDR 插件目录里，`server.properties`、世界存档、`../` 越界一律拒绝。

### 下载：一句「下载完成」不够

新建服务器时下载的核心 jar **必须核对**，否则就是给别人埋一颗雷：
文件少了几个字节，界面照样显示 100%，用户点启动才看到
「Invalid or corrupt jarfile」，然后开始怀疑是 Java 的问题、是配置的问题。

这个 bug 真发生过，根因是把进度监听挂在了源流上：

```ts
// 错的写法：这个 'data' 监听会让流立刻进入 flowing 模式，
// 而 pipeline 还没把写入端接上，中间挤出来的块直接被丢掉
source.on('data', (c) => (received += c.length))
await pipeline(source, createWriteStream(dest))
```

数据照样丢，进度照样显示 100%。正确做法是把计数放进管道内部
（一个 `Transform`），既不丢数据，也不破坏背压。

现在还会顺手核对：接口给了 `size` / `sha256`（Paper、原版、Purpur 都给）
就下完当场比一遍，对不上就删文件报错重来。这里有个坑值得记一笔：
**`content-length` 记的是「传输了多少」，不是「写到磁盘的有多少」**——
响应带 gzip 时它是压缩后的大小，而 fetch 会自动解压。拿它去核对，
所有被压缩的响应都会变成假的「下载不完整」。

### 服务端要哪个 Java，别猜

最先踩的坑是**版本号换写法了**：老版本是 `1.21.4`，新的直接叫 `26.2`。
`requiredJavaMajor()` 里的正则只认 `1.x`，认不出来的默认值给了 17，
于是新建界面写着「Minecraft 26.2 建议使用 Java 17+」——而 26.1 起官方要求 **Java 25**。

更麻烦的是**找不到那份 Java**：启动器（官方启动器、PCL 之类）会把运行时下载到
`.minecraft/runtime/java-runtime-epsilon/` 这类目录里，名字看不出大版本，
也不在 PATH 里。所以 Java 检测现在会扫这些位置，否则就会出现
「我明明装了 Java 25，CraftDesk 却说没有」。

三处一起改，才能让「起不来」变成「知道该装什么」：

| 位置 | 行为 |
|---|---|
| `javaHint.ts` | 认新版本号写法，26.1+ → Java 25 |
| `java.ts` | 扫启动器自带的运行时目录，名字猜不出大版本就实跑一次 `-version` |
| 新建服务器 | 事先检查手上有没有够用的 Java，没有就直说，别等下载完 60 MB 再崩 |
| `server:create` | 自动从已探测的列表里挑一个够用的（够用的里面挑最低的） |
| 日志识别 | 服务端自己印的 `requires running the server with Java 25 or above` 照抄给用户，并带上「当前用的是 Java 24」 |

### 「已经有一个在跑了」要说清楚

自己手动开过服的人早晚会遇到这种报错：

```
ERROR 启动失败
PermissionError: [WinError 32] 另一个程序正在使用此文件，进程无法访问。: 'logs\MCDR.log'
```

一屏 Python 堆栈，看不出重点其实是**这个目录里的 MCDReforged 已经在跑了**。
已经在跑的那个一直占着 `logs/MCDR.log`，新的这个启动时要轮转日志，
`unlink` 就被 Windows 拒了，整个 MCDR 直接躺下。

CraftDesk 现在会在启动前查一次这个文件：**改名成自己**，成功说明没人占、
抛 `EBUSY` 说明有人占。为什么用改名探而不是「打开看看能不能写」——
Python 的 `open()` 用的是共享读写模式，被占着也能打开，真正会失败的只有
改名/删除这类需要独占的操作（MCDR 自己就栽在 `unlink` 上）。
探到被占就拒绝启动，并把日志文件多大一起报出来（这种几 GB 的日志正是
MCDR 轮转卡住的原因）。

同一类问题还有代理端：**后端没开，玩家连上会被直接踢回**。代理端日志里
是 `unable to connect to server survival` 加一屏 `at io.netty...`，
看着像代理端自己炸了。现在这行会被翻译成一句话，并给一个「启动后端」按钮；
代理端启动后也会自己去探后端端口，一个都不在就把提示挂上，有后端起来
自动撤掉。

### 启动脚本为什么不参与启动

新建服务器时会自动在服务器目录里放一个 `start.bat`（非 Windows 是 `start.sh`），
已有的服务器可以在「启动配置」里点「生成启动脚本」补一个。它的用途是**手里有一份能直接跑的命令**：
服务器起不来时双击它，Java 的原话就在窗口里，不用猜是 CraftDesk 的问题
还是服务端自己的问题。

但 CraftDesk 默认**不**用它启动，还是按参数直接 `java -jar`。原因是脚本里的
内存和 JVM 参数是生成那一刻的值，如果拿它当启动方式，你在界面上改内存就
不会生效了——那正是 MCDReforged 那种「改了没用」的坑，没必要再造一个。
启动方式那一栏随时可以手动切到脚本。

脚本内容刻意只写 ASCII：Windows 的 cmd 按当前代码页解析 `.bat`，
中文注释在 GBK / UTF-8 之间倒腾一下就会变成乱码，把后面那行命令一起吃掉。

### 崩溃要说人话

`已崩溃` 加一个退出码基本等于没说。所以日志里能认出来的原因会直接说明：

| 日志里出现 | 界面提示 |
|---|---|
| `You need to agree to the EULA` | 需要先同意 EULA（带一键同意按钮） |
| `FAILED TO BIND TO PORT` | 端口被占用，去改 server-port |
| `UnsupportedClassVersionError` | Java 版本过低 |
| `Invalid or corrupt jarfile` | jar 损坏或不完整，删掉重下 |
| `Unable to access jarfile` | 找不到核心文件，检查「服务端核心」 |

### 配置文件写入的原子性

`craftdesk.json` 是先写 `.tmp` 再 `rename` 的。直接覆盖写的话，进程在写到一半时被
强制结束（任务管理器结束进程、断电）会把文件截断成 0 字节，用户的服务器列表就全没了。

## 目录结构

```
src/
  shared/         主进程与渲染进程共用的类型与元数据
  main/           Electron 主进程
    index.ts        窗口创建、生命周期
    ipc.ts          IPC 路由
    server-manager.ts  进程启动/停止、日志解析、玩家追踪
    importer.ts     服务端目录识别
    layout.ts       目录布局解析（核心目录、MCDR、代理端、各处目录）
    proxy.ts        代理端配置与版本读取
    registry.ts     扩展下载源（Modrinth API + MCDR 插件目录）
    sources.ts      统一多源搜索：Hangar / SpigotMC / CurseForge
    topology.ts     代理端与后端的从属关系
    velocity.ts     velocity.toml 按行读写（保留注释）
    network.ts      跨服网络导入：读代理端配置 + 在磁盘上找回后端
    images.ts       本地图片的读取与校验（背景图与服务器图标共用）
    icons.ts        服务器图标：复制进配置目录、按服务器清理旧图
    portable.ts     便携版的数据目录选择（exe 旁边能不能写、退回系统目录）
    proxySetup.ts   代理端初始配置（velocity.toml / config.yml 的生成与改写）
  renderer/src/
    graph.ts        关系星图的布局计算（纯函数，可单独测试）
    uiPrefs.ts      界面尺寸与背景的取值规则（纯函数，可单独测试）
    iconCache.ts    服务器图标的读取缓存（同一张图多处显示只读一次）
    serverIcon.ts   图标字符串的解析与文件名安全（shared，纯函数）
    backends.ts     后端转发配置核对
    configs.ts      配置文件枚举
    java.ts         Java 探测与版本匹配
    python.ts       Python 探测、mcdreforged 检测与 pip 安装
    mcdr.ts         MCDReforged 托管：init、config.yml、启动脚本、handler
    installers.ts   Forge / NeoForge 的版本表、安装器地址、启动入口查找
    downloader.ts   各类型的下载与新建（含跑官方安装器）
    properties.ts   server.properties 解析
    players.ts      ops/whitelist/banned 读写
    extmeta.ts      各加载器的描述文件解析（依赖、provides、嵌套 jar）
    relations.ts    扩展之间的依赖关系（谁要谁、缺没缺）
    plugins.ts      四类扩展的扫描与元数据
    zip.ts          只读 ZIP，用于读 jar / .mcdr 内元数据（支持内存里的嵌套 jar）
    backups.ts      备份与还原
  preload/        contextBridge 暴露的 API
  renderer/src/
    components/   标题栏、图标栏、服务器列表、工具栏、弹窗、编辑器
build/           应用图标（icon.png 打包用；标题栏用的是 renderer/public/logo.png）
    views/        总览、拓扑、控制台、下载扩展、服务器属性 / 跨服配置、设置
    panels/       文件、玩家、扩展、配置、备份
    styles/       主题
scripts/
  capture-window.ps1   截取窗口用于视觉检查（-Match 可按命令行筛选实例）
  click-window.ps1     在窗口内指定坐标点击
  test-scan.ts         对目录跑一遍识别 → 布局 → 扩展 → 配置
  test-proxy.ts        代理端识别与日志解析
  test-backends.ts     后端转发配置核对
  test-registry.ts     Modrinth 与 MCDR 源验证
  test-sources.ts      Hangar / SpigotMC / CurseForge 源验证
  test-removal.ts      删除的守门逻辑与落盘行为（29 项断言）
  test-delete-ui.mjs   危险操作端到端验证：CDP 点界面 → 检查磁盘（25 项断言，自带 fixture 与实例）
  test-download.ts     下载器：字节数、校验和、坏文件必须被拦下（11 项断言）
  test-startscript.ts  启动脚本生成（26 项断言，含纯 ASCII 检查、Forge/MCDR 的写法）
  test-installers.ts   Forge / NeoForge 版本表与安装器地址（21 项断言）
  test-forge-install.ts 真的装一遍 Forge / NeoForge 并启动到 Done
  test-mcdr.ts         MCDR 配置生成 / handler / 布局 / 真启动（54 项断言）
  test-mcdr-host.ts    下一个真核心交给 MCDR 托管，验证启动与优雅停止
  test-relations.ts    扩展依赖关系（45 项断言 + 跑真实服务器目录看误报）
  test-network-import.ts 跨服网络导入（12 项断言，含真实代理端的后端找回）
  test-graph.ts        关系星图的布局（31 项断言，含真实服务器）
  test-ui-prefs.ts     界面尺寸与背景的取值规则（41 项断言）
  test-server-icon.ts  服务器图标：解析 / 文件名安全 / 导入与清理（58 项断言）
  test-portable.ts     便携版数据目录的选择（20 项断言）
  test-core-dir.ts     核心目录识别：整合包服不会把 mods/ 当成核心（22 项断言）
  test-proxy-setup.ts  代理端初始配置：生成 + 用自己的解析器读回来（47 项断言）
  test-proxy-download.ts 代理端下载源：三家都列一遍，再真下一个验证（24 项断言，联网）
  test-remote-icon.ts  下载源图标：地址白名单 + 真抓一张 + 缓存与坏地址（17 项断言，联网）
  make-logo.py         从 build/icon.png 生成标题栏的 logo.png（换图标时跑）
  test-ping.ts         Server List Ping：能不能问出服务端自己报的人数与上限
  test-forwarding.ts   判定「这台能不能当代理端的后端」（14 项断言）
  repair-jar.ts        重新下载某个服务器的核心，用来修坏掉的 jar
  run-app.mjs          起一个实例来试（隔离配置 / 调试端口 / 清理残留，见「测试」）
  test-all.mjs         按代价分组跑完所有 test-*.ts
  ui-drive.mjs         用 CDP 驱动界面，比模拟鼠标可靠
  add-test-server.ts   开发期把目录直接写进配置，省去点界面
```

## 已验证

在真实服务端上跑通：MCDReforged 目录（Fabric 1.21.11，12.7 GB）。

| 项 | 结果 |
|---|---|
| 类型 / 版本 | `fabric` / `1.21.11` |
| 核心目录 | `server/`（子目录，非根目录） |
| 核心 jar | `server/fabric-server-launch.jar` |
| 启动脚本 | `[3] 启动 MCDR.bat`（中文名，排除了「一键安装/更新」） |
| MCDR 插件 | 31 个（含解包目录形式，依赖关系正确） |
| 模组 | 128 个 |
| MCDR 配置 | 30 个（`config.yml` + `config/`） |
| 模组配置 | 48 个（`server/config/`） |
| server.properties | `server/server.properties` 正确读取 |

代理端（本机那台 Velocity 跨服）：

| 项 | 结果 |
|---|---|
| 类型 / 版本 | `velocity` / `3.5.0`（从核心 jar 文件名取） |
| 推荐核心 | `velocity-3.5.0-SNAPSHOT-592.jar` |
| 监听端口 | `25566`（从 `velocity.toml` 的 `bind` 取） |
| 日志解析 | 110 行全部命中，正文无残留前缀 |
| 后端切换 | 28 次 `[server connection]` 正确排除，未误计为进出服 |
| 后端核对 | 15 个后端全部核对过：其中一个的别名与目录名对不上，靠端口匹配上了；`FabricProxy-Lite · 密钥一致` |

扩展下载源（`npm run` 之外的独立验证）：

| 项 | 结果 |
|---|---|
| Modrinth 模组 | Fabric 1.21.11 过滤后命中 66 个（搜索）/ 17,397 个（空查询按下载量） |
| Modrinth 插件 | Paper 1.21.11 命中 10,674 个 |
| MCDR 插件目录 | 227 个插件，中文名 / 描述 / 标签 / 下载量全部解析成功 |

删除与禁用（跑在 `tmp/uitest` 里的假服务器上，不碰真实目录）：

人数与上限（对着正在跑的真实服务器）：

| 项 | 结果 |
|---|---|
| 客户端看到的 | 义乌 · `JZDGH!!` · **1/99999** |
| Ping 回来的 | 版本 `1.21.11`、MOTD `JZDGH!!`、**1/99999**、名单 `Anonymous Player`、3ms |
| 界面显示 | `在线 1 / 99999`，跨服与生存服标成「外部启动」，同端口的测试服不受影响 |
| 没在监听的端口 | 返回 null，退回日志计数（不清零） |

| 项 | 结果 |
|---|---|
| 守门逻辑 | 29 项断言：盘根 / 主目录 / 数据目录一律拒绝，越界与绕行路径全部拦下 |
| 禁用 → 启用 | 磁盘上 `sodium.jar` ↔ `sodium.jar.disabled` 真的来回改名 |
| 删除模组 / 插件 | 文件进了回收站，同目录的 `server.properties` 毫发无伤 |
| 删服务器（只移除） | 列表与配置更新，磁盘目录原封不动 |
| 删服务器（连目录） | 名字打错按钮是灰的；打对之后目录真的没了，配置里也清了 |
| 端到端 | 25 项断言全过，界面 → IPC → 磁盘整条链路（含生成 start.bat） |

下载器（对着真实的 Paper 构建跑）：

| 项 | 结果 |
|---|---|
| 字节数 | 64,522,678 字节，与官方接口一致（修好之前少 4,107 字节） |
| sha256 | 与官方一致，用主进程自己的 zip 读取器能正常打开，`Main-Class` 在位 |
| 校验失败 | 删文件 + 报错，不留坏文件 |
| 大小不符 | 同样拦下 |

启动脚本（26 项断言）：内存 / JVM 参数 / UTF-8 输出参数 / 带空格的 java 路径引号 /
核心在子目录时先 cd 且 jar 去掉重复前缀 / 核心目录外改用绝对路径 / Forge 用 `@参数文件` /
MCDR 用 `python -m mcdreforged` / 代理端不加 nogui / 内容纯 ASCII / 重新生成会覆盖旧值。

启动失败排查（在真实服务器上走完整条链路）：

| 项 | 结果 |
|---|---|
| 坏 jar 复现 | `java -jar` → `Error: Invalid or corrupt jarfile`，与用户看到的一致 |
| 定位 | 官方 64,522,678 字节，本地少 4,107 字节，sha256 不符 |
| 修好之后 | 重新下载，字节数与 sha256 与官方一致，zip 结构完好（584 条目，Main-Class 在位） |
| 第二个坑 | 起起来才发现要 Java 25，机器上最高只有 24（启动器自带那份不在 PATH） |
| 端到端 | 在界面上点启动 → `Done (6.201s)!` → 运行中 / 端口 25565 / PID；优雅停止 → 退出码 0 |

Forge / NeoForge（真装一遍，不是只看代码）：

| 项 | 结果 |
|---|---|
| NeoForge 1.21.1 安装 | 官方安装器跑完，221 秒（含下载运行库），产物 6119 字节的参数文件 |
| 启动入口 | `libraries/net/neoforged/neoforge/21.1.252/win_args.txt` |
| 真的启动 | `java @win_args.txt` → `Done`，`server.properties` / `eula.txt` / `libraries/` 齐备 |
| 版本表 | Forge 77 个 MC 版本（1.20.1 → 推荐 47.4.10）、NeoForge 20 个（1.21.1 → 21.1.252 稳定版） |
| 安装器地址 | 两家都是 HTTP 200（5.8 MB / 6.6 MB），sha1 校验文件可用 |

MCDReforged 托管（这台机器上真的开起来一台）：

| 项 | 结果 |
|---|---|
| 环境验证 | 找到 6 个 Python，其中 3 个装了 mcdreforged（2.15.7 / 2.15.1） |
| 建服 | 原版 1.21.1 装进 `server/`，`mcdreforged init` 生成 permission.yml，config.yml 只改四个键 |
| 启动 | `python -X utf8 -m mcdreforged` → 15 秒看到 `Done`，界面显示运行中 / 端口 / 进程树内存 |
| 控制台 | 从 stdin 发 `list` → `There are 0 of a max of 20 players online` |
| 停止 | 发 `stop` → 3 秒内进程退出，服务端正常保存关闭 |
| 中文目录 | 目录名带中文时，Java 的 classpath 会打印成 GBK。补上 `-Dstdout.encoding=UTF-8` 之后 MCDR 不再抛 UnicodeDecodeError |
| 断言数 | `test-mcdr.ts` 54 项全过（handler / 模板改写 / 兜底模板 / 布局 / 真启动） |

跨服网络导入（拿本机那台真实的 Velocity 跨服跑的）：

| 项 | 结果 |
|---|---|
| 代理端 | `跨服` · velocity 3.5.0 · 监听 25566 · 配置里 8 个后端 |
| 磁盘找回 | 8/8 全部找到，且全部按端口匹配（配置里的别名和磁盘上的目录名对不上，靠名字根本找不到，靠端口才对上） |
| 误报检查 | 没有把别的目录认成后端；按端口匹配的结果端口确实一致 |
| 扫描耗时 | 13 个候选目录 68 ms |
| 配置解析 | BungeeCord 的 `config.yml`（`servers:` 段）也能读，且不会把 `listeners` 里的 host 当成后端 |
| 界面 | 清单列出「可导入 / 已在列表 / 只有地址」，默认勾选可导入的，可全选或单选 |

生效范围（拿本机 128 个模组的真实服务器跑的）：

| 项 | 结果 |
|---|---|
| 断言 | `test-relations.ts` 56 项全过（含 environment 的四种写法与真实目录统计） |
| 分布 | 仅客户端 60 · 仅服务端 35（其中 31 个是 MCDR 插件）· 两边都要 63 · 未知 1（那个损坏的 jar） |
| 误报检查 | Fabric 模组全部读出范围（不会留 unknown）；插件与 MCDR 插件一律 server |
| 实现 | 只是多读一个字段，扫描耗时没有变化（仍是 250 ms 量级） |

关系星图（拿本机 159 个扩展的真实服务器跑的）：

| 项 | 结果 |
|---|---|
| 断言 | `test-graph.ts` 31 项全过（坐标有限、连线两端都在、上限生效、缺失前置、真实数据） |
| 默认视图 | 中心自动挑被依赖最多的：Fabric API（74 个依赖它的），图上 86 个节点 / 85 条线 |
| 渲染 | 159 个扩展算一张图 1 ms（布局是纯计算，没有迭代求解） |
| 修掉的两个问题 | ① 数量上限对第一圈无效（300 个依赖者时限制 50 仍是 301 个节点）② 第二圈只画「装了」的邻居，缺失的前置看不见 |

界面尺寸与背景（跑在 `tmp/test-userdata` 的隔离实例上，用 CDP 驱动）：

| 项 | 结果 |
|---|---|
| 断言 | `test-ui-prefs.ts` 41 项全过（夹取、窗口适配、默认值一致性、样式里该有的规则） |
| 拖拽 | 左栏 300 → 420 跟手、松手落盘；右侧面板拖到下限停在 320，双击两侧都回到默认 |
| 空间不足 | 1440 窗口下把两侧都拉满：面板先让到 338，工作区保住 419，工具栏自动收起目录名和类型版本 |
| 窗口最小 | 1080 时侧栏 278 / 面板 320 / 工作区 419，两侧最小值（240 + 320）仍然放得下 |
| 背景图 | 选图 → 主进程读成 data URL → 图层透明度 0.7 / 面板 0.82 生效，重启后仍然在 |
| 容错 | 把图片文件删掉再启动：不显示背景、面板恢复实色，设置页写明「读不出来 + 原因」 |

服务器图标（同样跑在隔离实例上，CDP 驱动）：

| 项 | 结果 |
|---|---|
| 断言 | `test-server-icon.ts` 58 项全过（解析、文件名安全、真实复制、换图清理、坏输入） |
| 表情 / 文字 | 点一下立刻生效：配置写成 `text:🪨`，左树、工具栏、总览、属性页四处同时变 |
| 底色 | 12 色 + 「跟随服务端类型」；选完之后头像底色当场变（`#3b82f6`） |
| 图片 | 导入 → 文件复制进 `icons/icon-test-1.png`（196 字节，与源文件逐字节一致）→ 四处头像换成图片 |
| 清理 | 换回缩写后配置文件里变回空串，`icons/` 里的文件同时被删掉（不留孤儿） |
| 安全 | `file:../../craftdesk.json` 这类配置值只被当成「没有图标」，永远不会被拼成路径 |
| 入口 | 属性页点头像 / 名字旁的「换图标」/ 工具栏服务器菜单，三处都能打开同一个弹窗 |

便携版 exe（真的把它跑起来验的，不是只看构建日志）：

| 项 | 结果 |
|---|---|
| 产物 | `release/CraftDesk-1.0.0-portable.exe`，单文件 71.6 MB |
| 首次运行 | 在 exe 旁边生成 `data\craftdesk.json`（默认配置，含探测到的 Java 列表） |
| 已有配置 | 往配置里塞一台服务器（自定义图标 🐺、底色、侧栏宽度 420）再启动：列表原样读出来，界面宽度也是 420 |
| 便携模式 | 「设置 → 运行环境」显示「便携模式」标签 + 配置路径 + 一句话说明 |
| 单实例 | 第二个实例会自己退出并把已有窗口拉到前面（便携目录下同样有效） |
| 兜底 | `data\` 写不进去时退回 `%APPDATA%\CraftDesk`（`test-portable.ts` 用真实文件系统验的） |

代理端下载（真下一遍、真启动一遍）：

| 项 | 结果 |
|---|---|
| 版本表 | Velocity 23 个版本（正式版排在快照前，默认 4.2.0）/ Waterfall 5 个 / BungeeCord 最近 20 个成功构建 |
| Velocity | 下载 17 MB → 从官方 jar 里取出模板生成 `velocity.toml`（`config-version = "2.7"` 正确）→ 启动：`Listening on /[::]:25599` → `Done (0.87s)!` |
| BungeeCord | 下载 25 MB → 生成 `config.yml` → 启动：`Enabled BungeeCord ... :2100` → `Listening on /0.0.0.0:25598` |
| 端口 | 用的都是界面上填的端口，证明生成的那份配置真的被代理端读了 |
| 不该有的东西 | 代理端目录里没有 `eula.txt`、没有 `server.properties`（它也不需要） |

核心目录识别（真实案例：Forge 1.20.1 整合包服，245 个模组）：

| 项 | 结果 |
|---|---|
| 故障现象 | 导入后模组列表一个都不显示；配置里 `coreDir` 被写成了 `mods` |
| 原因 | 根目录没有 jar（Forge 1.17+ 就是这样）→ 老规则认领了第一个「有 jar 的子目录」= `mods/` |
| 修完 | 核心目录回到根目录，`mods` 245 个全部列出（其中 31 个前置缺失或 jar 损坏） |
| 存量数据 | 配置里存着 `coreDir: "mods"` 的那条不用重新导入，布局解析直接忽略这个错值 |
| 断言 | `test-core-dir.ts` 22 项：整合包服 / 只有 mods 的目录 / MCDR 的 `server/` / 中文名子目录 |

下载源图标（`npm test -- --net --only remote-icon`）：

| 项 | 结果 |
|---|---|
| 故障现象 | 下载扩展页一排破图；在页面里 new Image() 加载一个已知可用的 Modrinth 图标 → `error` |
| 原因 | 页面 CSP `img-src 'self' data:` 把 https 图标全拦了（浏览器根本没发请求） |
| 修完 | 一次搜索 20 条结果，20 个图标全部渲染成 `data:` 图片（png / webp），占位 0 个 |
| 白名单 | http / file / data / javascript 全部拒绝，只有 https 能往下走 |
| 缓存 | 同一张图第二次抓 0ms（主进程 LRU，120 张） |
| 落不下来 | 返回 JSON 的地址 →「不是图片」；404 →「HTTP 4xx」；域名不存在 →「图片下载失败」，都不会挂住 |

扩展依赖关系（拿本机两台真实服务器跑的，128 / 133 个模组）：

| 项 | 结果 |
|---|---|
| 断言 | `test-relations.ts` 56 项全过（五种描述文件 + 关系图 + BOM/坏文件容错） |
| 扫描耗时 | 159 个扩展 250 ms |
| 最大的前置 | Fabric API ← 73 个，Mod Menu ← 19 个，Carpet ← 15 个，MaLiLib ← 9 个 |
| 误报检查 | 没有把 `minecraft` / `fabricloader` / `forge` 报成缺失；嵌套提供的 `fabric-api-*` 全部解析出来 |
| 真实发现① | `yet_another_config_lib_v3-…jar` 的 zip 结构不完整（中央目录指向 1,126,926 字节处，文件只有 1,110,978 字节，少了约 16 KB），Java 同样读不了，6 个模组在等它 |
| 真实发现② | 两台服务器都缺 `prickle`（`EnchantmentDescriptions` 的前置） |

```bash
# 单独验证整条链路，不用开界面
npx esbuild scripts/test-scan.ts --bundle --platform=node --format=cjs \
  --outfile=tmp/test-scan.cjs && node tmp/test-scan.cjs "D:/你的/服务端目录"

# 扩展依赖关系（不给参数就跑本机两台真实服务器）
npx esbuild scripts/test-relations.ts --bundle --platform=node --format=cjs \
  --outfile=tmp/test-relations.cjs && node tmp/test-relations.cjs "D:/你的/服务器目录"

# 跨服网络导入（不给参数就跑本机那台跨服）
npx esbuild scripts/test-network-import.ts --bundle --platform=node --format=cjs \
  --outfile=tmp/test-network-import.cjs && node tmp/test-network-import.cjs "D:/你的/跨服目录"

# Forge / NeoForge：版本表与安装器地址（联网）
npx esbuild scripts/test-installers.ts --bundle --platform=node --format=cjs \
  --outfile=tmp/test-installers.cjs && node tmp/test-installers.cjs

# Forge / NeoForge：真的装一遍并启动（会下几百 MB，放 tmp/ 下）
npx esbuild scripts/test-forge-install.ts --bundle --platform=node --format=cjs \
  --outfile=tmp/test-forge-install.cjs && node tmp/test-forge-install.cjs neoforge 1.21.1

# MCDReforged：配置生成 / handler / 布局，最后真的把它跑起来
npx esbuild scripts/test-mcdr.ts --bundle --platform=node --format=cjs \
  --outfile=tmp/test-mcdr.cjs && node tmp/test-mcdr.cjs

# MCDReforged：下一个真核心，托管着开一台，验证启动与优雅停止
npx esbuild scripts/test-mcdr-host.ts --bundle --platform=node --format=cjs \
  --outfile=tmp/test-mcdr-host.cjs && node tmp/test-mcdr-host.cjs 1.21.1

# 验证代理端识别与日志解析
npx esbuild scripts/test-proxy.ts --bundle --platform=node --format=cjs \
  --outfile=tmp/test-proxy.cjs && node tmp/test-proxy.cjs "D:/你的/代理端目录"

# 界面尺寸与背景的取值规则（41 项：夹取、窗口适配、默认值一致性）
npx esbuild scripts/test-ui-prefs.ts --bundle --platform=node --format=cjs \
  --outfile=tmp/test-ui-prefs.cjs && node tmp/test-ui-prefs.cjs

# 服务器图标（58 项：解析、文件名安全、真实复制与清理）
npx esbuild scripts/test-server-icon.ts --bundle --platform=node --format=cjs \
  --outfile=tmp/test-server-icon.cjs && node tmp/test-server-icon.cjs
```

## 已知限制

- Forge / NeoForge 的版本表只给每个 MC 版本的推荐版 / 最新版，想装表里没有的构建号
  需要手动填（界面上那一栏可以直接改）
- MCDR 托管的服务器需要机器上有 Python 3.8+ 与 `mcdreforged`。没装时 CraftDesk 会说清楚
  缺哪一步并能用 pip 装上，但不代装 Python 本身
- MCDR 托管时内存写在它的 `config.yml` 里，界面上改内存不会同步过去（有提示条说明）
- 暂停/继续服务端进程未实现（需要挂起整个进程树，跨平台行为不一致）
- 备份是整目录复制，没有增量与压缩；大世界会占用较多磁盘
- 配置文件只做了语法高亮之外的纯文本编辑，没有针对 YAML / TOML 的校验
- MCDR 插件禁用靠改扩展名（`.mcdr.disabled`），MCDR 本身不会加载它，
  但要生效仍需 `!!MCDR reload plugin` 或重启
