# Tampermonkey 脚本集

本仓库存放个人用的 Tampermonkey / 油猴用户脚本。

## 脚本列表

| 脚本 | 版本 | 说明 |
|------|------|------|
| [cjk-mono.user.js](./cjk-mono.user.js) | 3.10.9 | 全站汉字/假名与等宽代码字体替换 |

---

## CJK/Mono 字体替换

通过 `@font-face` + `unicode-range` 只替换汉字、假名等字形；西文与图标字体走原字体栈。阅读站（如读通鉴）额外覆盖站点 CSS 变量。

### 功能

- **CJK 正文替换**：用本机字体（默认 `KingHwaOldSong-GB`）覆盖页面中的汉字、平假名、片假名
- **等宽代码字体**：`code` / `pre` / `kbd` / `samp` 使用独立等宽字体
- **按站点配置**：可为当前域名单独选择 CJK / 代码字体
- **站点黑名单**：一键排除不想替换的站点
- **Shadow DOM / iframe / 动态内容**：MutationObserver + 空闲批处理
- **输入框实时替换**：支持 `input`、`textarea`、`contenteditable`
- **控制面板**：`Ctrl+Shift+F` 开关与调字体
- **阅读站适配**（默认 [读通鉴](https://www.dutongjian.com/)）：仅在 allowlist 主机上覆盖 CSS 字体变量，避免正文/白话/注释/古本只有一部分生效

### 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（或兼容扩展）
2. 打开 raw 链接，扩展会弹出安装确认：  
   https://raw.githubusercontent.com/wafbys/cjk-mono-userscript/master/cjk-mono.user.js  
   或把 `cjk-mono.user.js` 全文粘贴到「新建脚本」
3. 确认本机已安装目标字体（默认 **KingHwaOldSong-GB**，family 名须完全一致）
4. 刷新目标网页；需要时 `Ctrl+Shift+F` 打开面板调整

已从旧文件名 `CJK-Mono 字体替换.js` 安装过的，请再导入一次 `cjk-mono.user.js`（`@name` / `@namespace` 不变，配置会保留）。

### 使用

| 操作 | 说明 |
|------|------|
| `Ctrl+Shift+F` | 打开 / 关闭控制面板 |
| 启用脚本 | 全局开关（仍受黑名单约束） |
| 正文 CJK 字体 | 当前站点的 CJK 字体（写入站点配置） |
| 代码字体 | 当前站点的等宽字体 |
| 重置为全局默认 | 删除当前站点覆盖，恢复默认字体 |
| + 添加当前 | 将当前域名加入黑名单 |
| 调试存储 | 在控制台打印 GM 存储与配置 |

配置持久化键：`CJK_MONO_FONT_CONFIG`（`GM_getValue` / `GM_setValue`）。

### 默认字体

| 类型 | 默认值 |
|------|--------|
| CJK | `KingHwaOldSong-GB`（仅此精确名称，无变体别名） |
| 代码 | `NewComputerModern Mono 10` |

面板可选 CJK：`KingHwaOldSong-GB`、`Ku Mincho`、`Ku Mincho BIG5GB`（本机补字版：Big5+GBK+JIS 缺字补全，字形来自京华老宋体-GB / 汇文明朝体）。  
可选代码字体：`NewComputerModern Mono 10`、`Cascadia Code`、`Fira Code`、`JetBrains Mono`、`Courier New`。

可在脚本内修改 `DEFAULT_CONFIG` / `FONT_CHOICES` 以增删选项。  
要让其它阅读站也走 CSS 变量覆盖，把主机后缀加进 `READING_SITE_SUFFIXES`。

### 原理简述

1. 注入 `@font-face` 族名 `CJKPatch`，`src: local("你的字体名")`，并限定 `unicode-range` 覆盖汉字基本区、扩展 A–J、假名、兼容区、全角等（不含韩文 Hangul）
2. 对含汉字/假名的节点写入 `font-family: "CJKPatch", … !important`；`unicode-range` 使西文仍走后面的原字体栈
3. 仅在阅读站 allowlist 上覆盖该站已有的 CSS 字体变量（前置 `"CJKPatch"`，保留原 stack）。守卫用 `setProperty` 包装 + 观察 `html[style]` 属性，不注入页面 JS 上下文
4. `@font-face` 在 `document-start` 等 `<head>` 出现后注入；DOM 扫描仍等 `body` 之后再 idle 批处理。SPA 路由（`pushState` / `replaceState` / `popstate`）与短时守护轮询做二次注入；面板重新启用会重新挂上这些钩子

### 读通鉴等站点说明

读通鉴等站用 CSS 变量分区控制字体，例如：

- 文言正文：`--font-family-classical`
- 白话文：`--font-family-translation`
- 注释 / UI：`--font-family-modern`、`--font-family-ui`
- 古本摘录：`--font-family-guben-excerpt-fixed`

旧版只改部分 DOM 节点时，会出现「一部分中文换了字体、一部分没换」。3.10+ 在 allowlist 站点通过变量覆盖 + 正文选择器兜底缓解该问题。

**仍可能不变的情况：**

- 字体本身缺字 → 浏览器回退到宋体等（正常缺字回退）
- 以图片显示的生僻字、Canvas 地图文字 → 无法用 CSS 改字体
- 本脚本注入前已创建的 closed Shadow DOM（`document-start` 之后新建的可拦截）

### 权限与匹配

```text
@match        *://*/*
@run-at       document-start
@grant        GM_getValue
@grant        GM_setValue
@downloadURL  …/cjk-mono.user.js
@updateURL    …/cjk-mono.user.js
```

### 版本摘要

| 版本 | 变更 |
|------|------|
| 3.10.9 | 面板 CJK 候选新增 `Ku Mincho BIG5GB`（本机补字字体，非回退逻辑变更） |
| 3.10.8 | 贴吧 CSS/DOM 补丁完全恢复为 3.10.5（`#app *` + 计算值已含 CJKPatch 则跳过） |
| 3.10.7 | 贴吧撤回 `body *` 字体覆盖（会让 DOM 补丁误判已打上、unicode-range 不生效）；改为 CSS 变量 + 文字节点 inline |
| 3.10.6 | 贴吧覆盖改为 `:root` / `body.cos-tieba`（无 `#app`）；Grok 保护器改为 `.message-bubble` / `data-testid`；去掉误绑的 `x.ai` |
| 3.10.5 | 补丁打在文字直接父节点；观察器补上后插入的文本节点。新版贴吧 CSR 覆盖其全局 `*{font-family:PingFang SC}` 与 `--cos-font-family` |
| 3.10.4 | 撤回 `@inject-into page` / `@sandbox raw` 以及 `cssText` / `setAttribute` / `removeProperty` 原型补丁（会卡住或空白页面）；`document-start` 只早注入样式。阅读站改观察 `html[style]` |
| 3.10.3 | `@run-at document-start`：先装样式与原型钩子，DOM 扫描仍等 body + idle；阅读站 CSS 变量守卫覆盖 `cssText` / `removeProperty` / `setAttribute('style')` |
| 3.10.2 | 文件更名为 `cjk-mono.user.js`；修复 idle 批处理中断、站点字体稀疏保存、开关后仍补丁；阅读站 CSS 变量改为 allowlist + 前置 CJKPatch |
| 3.10.1 | CJK 字体严格使用配置名（如 `KingHwaOldSong-GB`），去掉多余别名 |
| 3.10.0 | 阅读站 CSS 变量覆盖、SPA 路由重扫、扩展 unicode-range、变量 setProperty 守卫 |
| 3.9.0 | 按站点配置、黑名单、控制面板等基础能力 |

### 许可证

个人脚本，按需自用；字体版权归各字体作者所有。
