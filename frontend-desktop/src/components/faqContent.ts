// 应用内「常见问题」内容,按语言取用。zh 与 docs/常见问题.md 同源(改动请同步)。
// 内容无反引号，可安全用模板字符串。
import type { Lang } from '@/i18n'
import branding from '@branding'

// 用户交流群来自 branding.json；未配置（衍生品牌没有自己的群）则整句省略，
// 绝不能只换品牌名却留着上一代的群号。
const group = { name: branding.supportGroupName || '', id: branding.supportGroupId || '' }
const groupZh = group.name ? `，或在 ${group.name} 用户交流群（群号 ${group.id}）反馈` : ''
const groupEn = group.name ? `, or reach us in the ${group.name} user group (group ID ${group.id})` : ''

const zh = `# 常见问题（FAQ）

如未在此找到答案，可在会话中点击「上报此会话」反馈${groupZh}。

---

## 一、数据安全与隐私

### 使用本 Agent，我的本地数据会被上传到外网吗？会不会泄漏？

不会流向外部互联网。

- **大模型部署在公司内网。** 你与 Agent 的对话内容仅发送到公司内部署的大模型服务，不经过任何外部（互联网）大模型，不出公司网络。
- **Agent 的操作受安全策略约束。** Agent 的工具（读写工作区文件、在本机执行命令等）均在你本机运行；本机处于公司内网环境、对外网络访问本就受限，对工作区以外的写入会被阻止或要求确认——它无法擅自将你的文件传出。
- **不用于模型训练。** 不会在未经授权的情况下收集你的本地数据（现网配置、文档等）用于训练大模型。

### 那么，产品会收集哪些数据？

为改进产品与分析使用情况，我们会收集**会话数据**——也就是你和 Agent 的聊天内容，以及 Agent 在这次会话里都做了哪些事（执行了哪些命令、读写了哪些文件等）的记录。关于这些数据：

- **仅上传至公司内部的管理服务**，同样不出公司网络；
- 仅用于**产品分析与问题排查**，**不用于训练大模型**；
- 只有在你主动点击「上报此会话」时，才会额外附带该会话的运行日志，用于排查你反馈的具体问题。

简言之：你的文件与数据留在本地及公司内网，不会流向外网；我们收集的是"使用行为"层面的会话记录，用于持续改进产品。

---

## 二、命令执行与审核（工作模式）

### 三种工作模式

- **人工审核** —— **每一条命令**都需要你逐条确认。
- **半自动** —— 一般安全命令自动执行；**高风险操作**仍需你确认后才执行（删除、移动/重命名、修改权限、操作 Windows 注册表 / 服务 / 计划任务 / 环境变量等系统配置，以及涉及**工作区以外路径**的操作）。
- **自动模式** —— 不逐条确认，工作区内的写入不限制；工作区外的写入由**操作系统层面**拦截。

### 自动模式的安全性

在自动模式你不用逐条审查命令，安全边界改交给**操作系统**兜底：

- **工作区内**随便读写改；**工作区外**，Agent 执行命令 / 脚本时以**低完整性身份**运行，操作系统只准它写工作区（以及应用共享的 Python 环境、临时目录），**写到工作区以外会被系统直接拒绝**。读取、联网、运行程序都不受限——只限制"写"。
- **write_file / edit_file 写到工作区外**：直接拒绝，并提示改用相对路径。
- **少数致命命令直接拦截**：格式化磁盘、抹盘（dd）、关机 / 重启等（format / mkfs / dd / shutdown / reboot 之类）。

简言之：自动模式靠"操作系统只让它写工作区"兜底，但它不是隔离一切的沙箱。

### 回滚

如果Agent改错、删错了文件，你可以用**回滚**操作把工作区恢复到**某一轮对话之前**的状态。

- **只回滚工作区文件，不动对话**——聊天记录照旧，只是磁盘上的文件回到那一刻的样子。
- **怎么用**：在对话里把鼠标移到你发过的某条消息上，点旁边的回退图标，工作区就恢复到"发那条消息之前"的状态；那一刻之后**新增 / 修改 / 删除**的文件都会被还原。
- **点错了想撤销**：回滚成功后，那条回滚记录旁会出现「**撤销**」，把工作区恢复到回滚之前的样子。只能撤销**最近一次**回滚；一旦你**又发了新消息**，撤销入口就消失、无法再撤。
- **保留范围**：默认每个会话只保留**最近约 15 个**检查点，更早的会被自动清理。
- **文件上限**：单个文件超过**约 100MB** 就不纳入检查点，回滚不会影响它们（保持原样）。
- **多会话**：若同一工作区有其他会话在同时改动，它们的改动也会被一并回滚。

---

## 三、Skill（技能）怎么用

### Skill 是什么？我要如何"使用"它？

Skill 是给 Agent 的**专项能力包**——每个 Skill 打包了完成某类任务的说明、参考资料与可执行脚本（例如生成 PPT、处理 Excel、撰写报告）。**启用后你正常提出需求即可**，Agent 会在合适的时机自动调用对应的 Skill，无需你手动"运行"某个 Skill。

### 我把 Skill 文件夹放进了工作目录，为什么 Agent 没有当作技能使用？

因为直接放入工作目录，Agent 只会将其视为**普通参考文档**来阅读，**不会作为"技能"执行**。

要让它真正成为技能，必须先**导入**：在「Skill 市场 / Skill 管理」中导入（上传本地 zip，或从市场拉取）。导入后 Agent 才会识别它，并能够执行其内置的脚本能力。

### Skill 市场里的"引用"是什么意思？

云端 Skill 采用**引用式加载**——市场列表中显示的是云端 Skill 的"**引用**"（相当于一个指针/书签），**并不会预先将全部内容下载到本地**。当你真正用到某个 Skill 时，系统才会**按需拉取并落地**到本地。

因此：

- 看到"引用"，即表示云端存在该 Skill、随时可用；
- 真正执行时才下载落地——既节省本地空间，也保证使用的是最新版本。

---

## 四、大模型（LLM）配置

### 如何配置大模型？

进入「LLM 配置」新增一个账号，填写三项：

- **接口地址（API 地址）**：你的模型服务地址；
- **密钥（API Key）**：访问凭证；
- **模型名**：要使用的具体模型。

> 若已内置公司的默认账号，通常直接使用即可，无需自行配置。

### 接口（API 风格）为什么不能随意选择？

接口风格必须与你的模型服务**保持一致**，否则请求格式不匹配，调用会直接失败（报错或长时间无响应）：

- 模型服务是 **OpenAI 兼容** 的 → 选 **openai**；
- 模型服务是 **Anthropic（Claude）兼容** 的 → 选 **anthropic**。

不确定应选哪种，请查阅该模型服务的文档说明其兼容的接口类型，或咨询提供该服务的同事。

---

## 五、联网搜索（Web 搜索）

### 联网搜索能搜到什么？公司内网的东西能搜到吗？

Cowork 新增了**联网搜索**能力（web_search / web_fetch），但它**只能访问公司外部的公网资源**（互联网上的公开网站、搜索引擎），**目前访问不了公司内网**的系统、页面或文件。

- 需要查**公网信息**（公开资料、文档、技术方案等）时，它能帮你搜索并抓取网页；
- 公司**内部系统、内网站点、内部文档**等，联网搜索目前不涉及、也访问不到。

> **想让 Agent 分析公司内网的内容怎么办？** 可以在右侧「网页」tab 里输入该内网网址、把页面打开；打开后 Agent 就能读取**当前这个网页**的内容来帮你分析——相当于你先替它把内网页面打开，它再看。

### 联网搜索会向外发送什么？会不会把我本地的文件带出去？

当 Cowork 用联网搜索访问公网时：

- **会发送的**：你的**搜索关键词**和**要访问的网址**，以及浏览器访问网页时通常都会带上的常规信息（如浏览器类型；企业网络下网站还可能看到企业代理的出口 IP）。
- **不会发送的**：**不会把你本地工作目录里的文件（以及文件内容）传到外网**；也不会自动读取或上传你的浏览器历史 / 书签 / 密码，或你日常浏览器的 Cookie。搜索使用**隔离、非持久**的独立浏览器会话，**不共享**你 Chrome / Edge 或应用内浏览器的登录状态。

关于**企业网络下的认证**：在公司网络里，系统可能经 Windows 代理、PAC、企业证书及 NTLM 集成认证访问公网。此时企业代理可能识别到当前设备或企业账号，但认证由 Windows/Chromium 网络层完成——**密码、Cookie、认证 Token 不会传给大模型，也不会出现在搜索结果或网页来源里**。

关于**抓取结果**：网页抓取的内容交给大模型处理（模型部署在公司内网，见「数据安全与隐私」），**不会写入你的工作区**。会话里可能保留工具调用参数，以及网页的网址、标题、来源类型等少量信息（用于展示与历史回放）；网页正文本身不会作为文件保存。

> **请注意**：你输入的**搜索词和完整网址会被发送到外部网站**。因此请勿在搜索词或网址里填写密码、API Key、个人敏感信息、公司机密内容，或带临时访问凭据的链接。
`

const en = `# FAQ

If you can't find your answer here, click "Report this session" in a conversation${groupEn}.

---

## 1. Data Security & Privacy

### When I use the Agent, is my local data uploaded to the internet? Could it leak?

No — it does not leave for the public internet.

- **The LLM is deployed on the company intranet.** Your conversations with the Agent are sent only to the company's internally hosted model service — never to any external (internet) model, and never outside the company network.
- **The Agent's actions are constrained by security policy.** The Agent's tools (reading/writing workspace files, running commands on your machine, etc.) all run on your own machine; the machine sits on the company intranet where outbound internet access is already restricted, and writes outside the workspace are blocked or require confirmation — it cannot send your files out on its own.
- **Not used for model training.** Your local data (network configs, documents, etc.) is not collected for training the model without authorization.

### So what data does the product collect?

To improve the product and understand usage, we collect **session data** — that is, your chat exchanges with the Agent, plus a record of what the Agent did during the session (which commands it ran, which files it read or wrote, and so on). About this data:

- It is uploaded **only to the company's internal management service**, and likewise never leaves the company network;
- It is used **only for product analysis and troubleshooting**, **not for training the model**;
- Only when you actively click "Report this session" is the session's run log additionally attached, to help diagnose the specific issue you reported.

In short: your files and data stay local and on the company intranet and never go to the internet; what we collect is usage-level session records, used to keep improving the product.

---

## 2. Command Execution & Review (Work Mode)

### The three work modes

- **Manual review** — **every single command** requires your confirmation.
- **Semi-auto** — ordinary safe commands run automatically; **high-risk operations** still require your confirmation (deleting, moving / renaming, changing permissions, operating the Windows registry / services / scheduled tasks / environment variables and other system config, and anything touching paths **outside the workspace**).
- **Auto** — no per-command confirmation; writes inside the workspace are unrestricted, while writes outside the workspace are blocked at the **operating-system level**.

### Is Auto mode safe?

In Auto mode you don't review commands one by one; the safety boundary is delegated to the **operating system**:

- **Inside the workspace** you read / write / change freely; **outside the workspace**, when the Agent runs commands / scripts it runs at **low integrity**, and the OS only lets it write the workspace (plus the app's shared Python environment and a temp dir). **Writing anywhere outside the workspace is refused by the OS.** Reading, network access, and running programs are unrestricted — only *writing* is limited.
- **write_file / edit_file writing outside the workspace**: refused outright, with a hint to use a relative path.
- **A few fatal commands are blocked outright**: formatting a disk, wiping with dd, shutdown / reboot, and the like (format / mkfs / dd / shutdown / reboot).

In short: Auto mode relies on "the OS only lets it write the workspace" as its backstop; but it is not an isolate-everything sandbox.

### Rewind

If the Agent changes or deletes the wrong files, you can **rewind** the workspace back to its state before a given turn.

- **Files only, not the conversation** — your chat history stays; only the files on disk return to how they were at that moment.
- **How**: in the conversation, hover over a message you sent and click the rewind icon next to it; the workspace returns to its state before that message — any files created / modified / deleted since are undone.
- **Changed your mind**: right after a rewind, an **Undo** appears next to that rewind record and restores the workspace to how it was before the rewind. Only the **most recent** rewind can be undone, and the option disappears once you **send a new message**.
- **How many are kept**: by default only the **most recent ~15** checkpoints per session are kept; older ones are cleaned up automatically, so very old turns may no longer be rewindable.
- **File size limit**: single files larger than **~100MB** aren't checkpointed, so rewind leaves them untouched.
- **Multiple sessions**: if another session is changing the same workspace at the same time, its changes are rewound too.

---

## 3. How to Use Skills

### What is a Skill? How do I "use" it?

A Skill is a **specialized capability pack** for the Agent — each Skill bundles instructions, reference material, and runnable scripts for a class of task (e.g. generating PPT, processing Excel, writing reports). **Once enabled, just state your request normally**; the Agent calls the right Skill at the right moment — you don't manually "run" a Skill.

### I put a Skill folder in my working directory — why doesn't the Agent use it as a Skill?

Because when placed directly in the working directory, the Agent only treats it as an **ordinary reference document** to read — **not as a "Skill" to execute**.

To make it a real Skill, you must first **import** it: in **Skill Market / Skill Management**, import it (upload a local zip, or pull from the market). After importing, the Agent recognizes it and can run its built-in script capabilities.

### What does "reference" mean in the Skill Market?

Cloud Skills use **reference-based loading** — what the market list shows is a "**reference**" to a cloud Skill (like a pointer/bookmark); it does **not** download all the content to your machine in advance. Only when you actually use a Skill does the system **fetch and materialize** it locally on demand.

So:

- Seeing a "reference" means the cloud Skill exists and is ready to use;
- It is only downloaded/materialized when actually executed — saving local space and ensuring you use the latest version.

---

## 4. Configuring the LLM

### How do I configure the model?

Go to **LLM Providers**, add an account, and fill in three fields:

- **API endpoint (API URL)**: your model service address;
- **API Key**: the access credential;
- **Model name**: the specific model to use.

> If a company default account is already built in, you can usually just use it — no setup needed.

### Why can't I pick the interface (API style) at random?

The interface style must **match** your model service, or the request format won't line up and the call fails outright (an error, or a long hang):

- If the service is **OpenAI-compatible** → choose **openai**;
- If the service is **Anthropic (Claude)-compatible** → choose **anthropic**.

If you're unsure which to pick, check the model service's docs for which interface it is compatible with, or ask whoever provides the service.

---

## 5. Web Search

### What can web search reach? Can it search the company intranet?

Cowork now has **web search** (web_search / web_fetch), but it can **only reach resources outside the company — the public internet** (public websites and search engines). It **currently cannot access the company intranet** — internal systems, sites, or files.

- When you need **public information** (public materials, docs, technical references), it can search and fetch web pages for you;
- Internal systems, intranet sites, internal documents, etc. are, for now, out of scope and unreachable by web search.

> **Need the Agent to analyze something on the company intranet?** Open that intranet URL in the **"Web" tab on the right**; once the page is open, the Agent can read **that current page** and help you analyze it — in effect, you open the intranet page for it, and it reads what's there.

### What does web search send out? Could it take my local files out?

When Cowork uses web search to reach the public internet:

- **What is sent**: your **search keywords** and the **URL you want to visit**, plus the routine information a browser normally sends when loading a page (such as browser type; on an enterprise network the site may also see the enterprise proxy's egress IP).
- **What is NOT sent**: it **does not send your local working-directory files (or their contents) out to the internet**; nor does it automatically read or upload your browser history / bookmarks / passwords, or your everyday browser cookies. Search runs in an **isolated, non-persistent** browser session and does **not share** the login state of your Chrome / Edge or the in-app browser.

On **authentication in an enterprise network**: on the company network, the system may reach the public internet via a Windows proxy, PAC, an enterprise certificate, and NTLM integrated authentication. The enterprise proxy may identify the current device or enterprise account, but authentication is handled by the Windows/Chromium network layer — **passwords, cookies, and auth tokens are never passed to the LLM, nor do they appear in search results or the web-source view**.

On **fetched content**: fetched web content is handed to the model (which is deployed on the company intranet — see "Data Security & Privacy") and is **not written to your workspace**. The session may retain the tool-call parameters and a little page info (URL, title, source type) for display and history replay; the page body itself is not saved as a file.

> **Please note**: the **search terms and full URLs you enter are sent to external websites**. So do not put passwords, API keys, personal sensitive information, company confidential content, or links carrying temporary access credentials into search terms or URLs.
`

export const FAQ_MD: Record<Lang, string> = { zh, en }
