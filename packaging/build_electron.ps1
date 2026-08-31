<#
.SYNOPSIS
  NetLIVE Cowork — 完整桌面应用打包 (Electron + PyInstaller)。
.DESCRIPTION
  流水线：frontend-desktop 构建 → PyInstaller 后端 → 复制 resources/.env.example
  → (若存在) drawing-engine 拓扑引擎整目录(含 node_modules 与图标库)
    + 内置 Node runtime + 三子命令冒烟 → electron-builder 出 NSIS 安装包。
  产物**一套**：
    build\electron-dist\<productName> Setup <version>.exe (+ .blockmap + latest.yml)
    exe 里含：两个拓扑工具(draw_topology / export_diagram)、drawing-engine Node 引擎、
    内置 Node runtime、图标库（drawing-engine/topology-icons/）。**不含任何 skill。**

  本脚本**不再打 skill 包**。原先第 5 节会把 resources/skills/topology-drawing 打成 zip
  发布，现已移除：skill 的分发不该跟 exe 的构建绑在一起——绑着的时候，"skill 改了没重打"
  和"重打了没删旧版本"都成了要靠人记得的事，而两者出错都不报错。skill 源仍在
  resources/skills/ 下，怎么分发另行决定。
.PARAMETER Version       目标版本号（x.y.z）。传了就在构建前戳进 electron/package.json、
  electron/package-lock.json、pyproject.toml；不传则只校验三者是否一致（不改文件）。
.PARAMETER SkipFrontend  跳过前端构建（需 frontend-desktop/dist 已存在）。
.PARAMETER SkipBackend   跳过 PyInstaller（需 build/dist/<branding.backendName> 已存在）。
.PARAMETER SkipInstall   跳过 uv sync / PyInstaller 安装。
.NOTES
  纪律（沿用 release-runbook.md）：纯后端/纯前端改动都必须全量重打——前端 dist 经
  PyInstaller 内嵌进后端，跳过后端会让安装包仍带旧前端。一次只跑一个构建。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build_electron.ps1 -Version 0.4.20
#>
param(
  [string]$Version,
  [switch]$SkipFrontend,
  [switch]$SkipBackend,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$Root     = Split-Path $PSScriptRoot -Parent
$BuildDir = Join-Path $Root "build"

function Write-Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-OK([string]$m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Err([string]$m)  { Write-Host "  [ERROR] $m" -ForegroundColor Red; exit 1 }
function Write-Warn([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }

# 品牌标识唯一来源 = electron/branding.json。运行期 electron/main.js 与打包期
# packaging/netlive-cowork.spec 读的都是这一份；本脚本再把它注入 package.json 的 build 段
# （见下方 §0.5）——因为 electron-builder 打包时会剥掉 build 段，运行期读不到，故必须双写。
$BrandingPath = Join-Path $Root "electron\branding.json"
if (-not (Test-Path $BrandingPath)) { Write-Err "electron/branding.json 不存在——品牌标识唯一来源缺失" }
# 必须用 File::ReadAllText（按 UTF-8 解码）而非 Get-Content -Raw：后者在 Windows PowerShell 5.1
# 下对无 BOM 文件按系统 ANSI 码页解码，branding.json 里的中文注释会变乱码 → ConvertFrom-Json 直接报错。
$Branding = [System.IO.File]::ReadAllText($BrandingPath) | ConvertFrom-Json
foreach ($k in @('appId','productName','appDataDir','backendName')) {
  if (-not $Branding.$k) { Write-Err "electron/branding.json 缺少必填字段 '$k'" }
}
# 后端 dist 目录名由 spec 的 COLLECT name 决定，二者同源于 branding.backendName。
$DistDir  = Join-Path $BuildDir "dist\$($Branding.backendName)"

# ── 版本读写辅助 ──────────────────────────────────────────────────────────────
# 写入一律用 UTF-8 无 BOM + 原文正则替换（不整体 ConvertTo-Json，避免打乱缩进/键序）。
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Get-JsonVersion([string]$path) {
  # 用正则取首个顶层 "version"（package.json / package-lock.json 的 root version 均在最前）；
  # 避免 Windows PowerShell 5.1 的 ConvertFrom-Json 在 package-lock.json 的重复键上报错。
  $m = [regex]::Match((Get-Content -Raw $path), '"version"\s*:\s*"([^"]+)"')
  if ($m.Success) { $m.Groups[1].Value } else { $null }
}
function Get-PyprojectVersion([string]$path) {
  $m = [regex]::Match((Get-Content -Raw $path), '(?m)^version\s*=\s*"([^"]+)"')
  if ($m.Success) { $m.Groups[1].Value } else { $null }
}
# package.json：仅一个顶层 "version"，整文件替换即可。
function Set-JsonVersion([string]$path, [string]$ver) {
  $raw = [System.IO.File]::ReadAllText($path)
  $raw = [regex]::Replace($raw, '("version":\s*")[^"]*(")', "`${1}$ver`$2")
  [System.IO.File]::WriteAllText($path, $raw, $Utf8NoBom)
}
# package-lock.json：只改「首个 node_modules 条目之前」的头部——即 root 与 packages['']
# 两处项目版本；其后每个依赖也有 "version"，绝不能碰。
function Set-LockVersion([string]$path, [string]$ver) {
  $raw = [System.IO.File]::ReadAllText($path)
  $idx = $raw.IndexOf('"node_modules/')
  if ($idx -lt 0) { $idx = $raw.Length }
  $head = $raw.Substring(0, $idx); $tail = $raw.Substring($idx)
  $head = [regex]::Replace($head, '("version":\s*")[^"]*(")', "`${1}$ver`$2")
  [System.IO.File]::WriteAllText($path, $head + $tail, $Utf8NoBom)
}
# package-lock.json 的包名：与 Set-LockVersion 同理，只改「首个 node_modules 条目之前」的
# 头部（root 与 packages['']）；其后每个依赖也有 "name"，绝不能碰。
function Set-LockName([string]$path, [string]$name) {
  $raw = [System.IO.File]::ReadAllText($path)
  $idx = $raw.IndexOf('"node_modules/')
  if ($idx -lt 0) { $idx = $raw.Length }
  $head = $raw.Substring(0, $idx); $tail = $raw.Substring($idx)
  $head = [regex]::Replace($head, '("name":\s*")[^"]*(")', "`${1}$name`$2")
  [System.IO.File]::WriteAllText($path, $head + $tail, $Utf8NoBom)
}
# 单个 JSON 字符串字段就地改值（只改首个匹配，键在 package.json 内均唯一）。
# 同样走原文正则替换，不整体 ConvertTo-Json——保住缩进与键序，diff 才干净。
function Set-JsonStringField([string]$path, [string]$key, [string]$value) {
  $raw = [System.IO.File]::ReadAllText($path)
  $pattern = '("' + [regex]::Escape($key) + '"\s*:\s*")[^"]*(")'
  $rx = New-Object System.Text.RegularExpressions.Regex $pattern
  if (-not $rx.IsMatch($raw)) { return $false }
  # 替换串里的 $ 需转义，否则会被当成分组引用
  $safe = $value -replace '\$', '$$$$'
  [System.IO.File]::WriteAllText($path, $rx.Replace($raw, ('${1}' + $safe + '${2}'), 1), $Utf8NoBom)
  return $true
}
# pyproject.toml：锚定行首 version=（^ 排除 target-version 那行）。
function Set-PyprojectVersion([string]$path, [string]$ver) {
  $raw = [System.IO.File]::ReadAllText($path)
  $raw = [regex]::Replace($raw, '(?m)^(version\s*=\s*")[^"]*(")', "`${1}$ver`$2")
  [System.IO.File]::WriteAllText($path, $raw, $Utf8NoBom)
}

# ── 0. 版本戳入 / 一致性校验 ───────────────────────────────────────────────────
$pkgJson  = Join-Path $Root "electron\package.json"
$lockJson = Join-Path $Root "electron\package-lock.json"
$pyProj   = Join-Path $Root "pyproject.toml"
if ($Version) {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { Write-Err "非法版本号 '$Version'（须形如 x.y.z）" }
  Write-Step "戳入版本 $Version"
  $old = Get-JsonVersion $pkgJson
  Set-JsonVersion      $pkgJson  $Version
  Set-LockVersion      $lockJson $Version
  Set-PyprojectVersion $pyProj   $Version
  Write-OK "electron/package.json      $old -> $Version"
  Write-OK "electron/package-lock.json 已同步（root + packages['']）"
  Write-OK "pyproject.toml             已同步"
} else {
  Write-Step "校验版本一致性（未传 -Version，不改文件）"
  $seen = [ordered]@{
    'electron/package.json'      = Get-JsonVersion $pkgJson
    'electron/package-lock.json' = Get-JsonVersion $lockJson
    'pyproject.toml'             = Get-PyprojectVersion $pyProj
  }
  $distinct = @($seen.Values | Sort-Object -Unique)
  if ($distinct.Count -gt 1) {
    Write-Warn "版本号不一致，将按各文件现值构建："
    $seen.GetEnumerator() | ForEach-Object { Write-Warn "    $($_.Key) = $($_.Value)" }
    Write-Warn "如需统一，请用 -Version <x.y.z> 重跑。"
  } else {
    Write-OK "版本一致：$($distinct[0])"
  }
}

# ── 0.5 品牌注入（branding.json → package.json 的 build 段）────────────────────
# 每次构建都无条件覆写：branding.json 是唯一来源，package.json 里的这几个键是它的投影。
# 幂等——值一致时文件内容不变。appId 尤其关键：NSIS 用它写进开始菜单快捷方式，运行期
# main.js 的 setAppUserModelId 必须逐字相同，否则任务栏分组与系统通知都会失效。
Write-Step "注入品牌标识 (electron/branding.json → package.json)"
# 'name' 是 npm 包名，但在 Windows 上会外溢成用户可见的东西：NSIS 卸载程序文件名
# （__uninstaller-nsis-<name>.exe）与 Electron 拼给 webview 的 UA 里的应用标识。
$brandFields = [ordered]@{
  'name'          = $Branding.npmName
  'description'   = "$($Branding.productName) Desktop Application"
  'appId'         = $Branding.appId
  'productName'   = $Branding.productName
  'copyright'     = $Branding.productName
  'shortcutName'  = $Branding.productName
}
foreach ($kv in $brandFields.GetEnumerator()) {
  if (Set-JsonStringField $pkgJson $kv.Key $kv.Value) {
    Write-OK "$($kv.Key.PadRight(13)) = $($kv.Value)"
  } else {
    Write-Err "package.json 里找不到键 '$($kv.Key)'——品牌注入失败，构建中止"
  }
}

# extraResources 里后端产物的来源路径也跟着 backendName 走。
# 不能用 Set-JsonStringField：'from' 在 package.json 里有两条（backend 与 default_data），
# 按键名只改首个是靠出现顺序的脆弱假设。这里按值的 '../build/dist/' 前缀锚定，唯一且与顺序无关。
# 漏改这里的后果很隐蔽：若上一品牌的 build/dist/<旧名>/ 残留在盘上，electron-builder 会静默
# 打包那份过期后端，装出来的应用启动即报「找不到后端程序」。
# package-lock.json 的包名跟着 package.json 走，否则 npm 会判定两者不同步。
Set-LockName $lockJson $Branding.npmName
Write-OK "package-lock  name = $($Branding.npmName)"

$rawPkg = [System.IO.File]::ReadAllText($pkgJson)
$fromRx = New-Object System.Text.RegularExpressions.Regex '("from"\s*:\s*"\.\./build/dist/)[^"]*(")'
if (-not $fromRx.IsMatch($rawPkg)) {
  Write-Err "package.json 的 extraResources 里找不到 '../build/dist/…' 后端来源路径——品牌注入失败"
}
[System.IO.File]::WriteAllText(
  $pkgJson, $fromRx.Replace($rawPkg, ('${1}' + $Branding.backendName + '${2}'), 1), $Utf8NoBom)
Write-OK "extraResources = ../build/dist/$($Branding.backendName)"

# ── 1. 构建桌面前端 ───────────────────────────────────────────────────────────
if (-not $SkipFrontend) {
  Write-Step "构建前端 (npm run build in frontend-desktop/)"
  $frontendDir = Join-Path $Root "frontend-desktop"
  if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
    Write-Host "  安装前端依赖 (npm install)..."
    $r = Start-Process npm.cmd -ArgumentList "install" -WorkingDirectory $frontendDir -NoNewWindow -Wait -PassThru
    if ($r.ExitCode -ne 0) { Write-Err "npm install 失败" }
  }
  $r = Start-Process npm.cmd -ArgumentList "run","build" -WorkingDirectory $frontendDir -NoNewWindow -Wait -PassThru
  if ($r.ExitCode -ne 0) { Write-Err "桌面前端构建失败" }
  Write-OK "前端已输出到 frontend-desktop/dist"
} else {
  if (-not (Test-Path (Join-Path $Root "frontend-desktop\dist"))) {
    Write-Err "frontend-desktop/dist 不存在，请去掉 -SkipFrontend 或先手动构建"
  }
  Write-Warn "跳过前端构建"
}

# ── 2. 打包 Python 后端 (PyInstaller) ─────────────────────────────────────────
if (-not $SkipBackend) {
  Write-Step "打包 Python 后端 (PyInstaller)"
  if (-not $SkipInstall) {
    uv sync --project $Root
    if ($LASTEXITCODE -ne 0) { Write-Err "uv sync 失败" }
    Write-OK "Python 依赖就绪"
  }

  # 全量重打前清掉旧产物（残留会打出"空壳"且不报错）
  if (Test-Path $DistDir) { Remove-Item $DistDir -Recurse -Force }
  New-Item -ItemType Directory -Force $BuildDir | Out-Null

  Set-Location $Root
  # --with：在项目环境基础上临时带上 pyinstaller/setuptools 跑，避免 `uv pip install`
  # 的解释器发现问题；host 包 netlivecowork（editable）与 core ctx_weft（vendored .pyc
  # wheel，装在 .venv site-packages）对分析均可见；core 子模块由 spec 的 collect_submodules 兜底。
  uv run --project $Root --with pyinstaller --with setuptools pyinstaller "$PSScriptRoot\netlive-cowork.spec" --noconfirm `
    --distpath "$BuildDir\dist" `
    --workpath "$BuildDir\work"
  if ($LASTEXITCODE -ne 0) { Write-Err "PyInstaller 打包失败" }

  # 运行时资源复制到 exe 同级（_run.py 冻结态按 exe_dir/resources 解析）。
  # 关键：随包默认数据一律取干净的 packaging/default_data，绝不拷开发用的根 resources/——
  # 后者含真实 API key 的 llm_configs、以及本地新增/改动的 skill，属“当前运行数据”，严禁入包。
  $resDst  = Join-Path $DistDir "resources"
  $defData = Join-Path $Root "packaging\default_data"
  if (-not (Test-Path $defData)) { Write-Err "packaging/default_data 不存在，无法打出随包默认数据" }
  if (Test-Path $resDst) { Remove-Item $resDst -Recurse -Force }
  New-Item -ItemType Directory -Force $resDst | Out-Null
  # skills / agents：来自 default_data（seedBundledResource 会再把它们灌进用户 AppData）
  # 注意：**topology-drawing 不随包**，它在 resources/skills/ 里（根 resources/ 从不进 exe，
  # 打包源一律取 packaging/default_data/，所以放那儿天然不会被打进去）。本脚本原先还会把它
  # 单独打成 zip 发布，那一节已移除——skill 怎么分发不再由构建脚本决定。
  # 所以 default_data/skills 通常是空的（只有 .gitkeep），下面的拷贝会产出一个空目录，
  # 这是预期行为，不是漏打。
  foreach ($sub in @("skills","agents")) {
    $s = Join-Path $defData $sub
    if (Test-Path $s) { Copy-Item $s (Join-Path $resDst $sub) -Recurse -Force }
    else { Write-Warn "packaging/default_data/$sub 缺失，跳过" }
  }
  # mcp.json：MCPServerStore 从 resources 根读取。llm_configs 故意不入包——
  # 出厂零 LLM 配置，用户首启自行添加（写入 exe_dir/resources/llm_configs）。
  $mcpDefault = Join-Path $defData "mcp.json"
  if (Test-Path $mcpDefault) { Copy-Item $mcpDefault (Join-Path $resDst "mcp.json") -Force }
  # .env.example 同样取 packaging/default_data（随包出厂模板，main.js 首启读 backend/.env.example
  # 播种用户 .env）——不再用开发用的根 .env.example。
  $envDefault = Join-Path $defData ".env.example"
  if (-not (Test-Path $envDefault)) { Write-Err "packaging/default_data/.env.example 不存在，无法打出随包 .env 模板" }
  Copy-Item $envDefault (Join-Path $DistDir ".env.example") -Force
  Write-OK "后端已输出到 $DistDir（resources 取自 packaging/default_data，未含开发密钥/本地 skill）"

  # ── 随包内置 Python runtime（workspace venv 的创建源；冻结态 sys.executable 不可用）──
  Write-Step "内置 Python runtime (python-build-standalone via uv)"
  $PyVersion = "3.11.9"                 # 与后端基线 3.11 对齐；改版本只动这一行
  $PyRtDir   = Join-Path $DistDir "python-runtime"
  if (Test-Path $PyRtDir) { Remove-Item $PyRtDir -Recurse -Force }

  # uv 下载/缓存 PBS 并校验；--install-dir 让布局可预测，便于定位 python.exe
  $PyStore = Join-Path $BuildDir "py-runtime-store"
  New-Item -ItemType Directory -Force $PyStore | Out-Null
  $env:UV_PYTHON_INSTALL_DIR = $PyStore

  # 已经装过同版本就复用。**原先每次都 Remove-Item 整个 store 再重装** ——
  # 那是这条流水线里最慢的一步（要重新解包 23.9MB 的 PBS，网络不好时会长时间无输出，
  # 看起来像卡死）。而它与本次改动毫无关系：同一个版本号，装出来的东西一模一样。
  #
  # 复用不放松安全性：下面那道"必须在 $PyStore 之下"的硬校验照旧，
  # 误挑系统 Python 仍然会让打包失败。
  $reusable = Get-ChildItem $PyStore -Directory -EA 0 |
              Where-Object { Test-Path (Join-Path $_.FullName "python.exe") } |
              Where-Object { (& (Join-Path $_.FullName "python.exe") -c "import platform;print(platform.python_version())" 2>$null) -eq $PyVersion } |
              Select-Object -First 1
  if ($reusable) {
    Write-OK "复用已装的内置 Python $PyVersion（跳过下载）"
  } else {
    uv python install $PyVersion
    if ($LASTEXITCODE -ne 0) { Write-Err "uv python install $PyVersion 失败" }
  }

  # 不用 `uv python find`：它会优先挑项目 .venv 或系统里同版本的 Python（CI 上 uv sync
  # 建的 .venv 恰好也是 3.11.9 → 被误挑）。直接在 $PyStore 里定位刚装好的内置解释器。
  $PyDir = Get-ChildItem $PyStore -Directory |
           Where-Object { Test-Path (Join-Path $_.FullName "python.exe") } |
           Select-Object -First 1
  if (-not $PyDir) { Write-Err "在 $PyStore 未找到内置 Python（python.exe）——uv python install 是否成功？" }
  $PyExe = Join-Path $PyDir.FullName "python.exe"
  if (-not (Test-Path $PyExe)) { Write-Err "定位内置 Python 失败: '$PyExe'" }
  # 必须是刚装进 $PyStore 的托管解释器；若 uv 挑了机器上的系统 Python（同版本），
  # 拷进包的可能不可重定位 → 在用户机上坏。这里硬卡，宁可打包失败也不出坏包。
  $PyStoreFull = (Resolve-Path $PyStore).Path
  if (-not ([System.IO.Path]::GetFullPath($PyExe)).ToLower().StartsWith($PyStoreFull.ToLower())) {
    Write-Err "uv python find 返回了非内置 Python ($PyExe)，不在 $PyStoreFull 下——疑似挑了系统 Python"
  }
  $PyRoot = Split-Path $PyExe -Parent     # PBS install_only: python.exe 在 runtime 根
  if (-not (Test-Path (Join-Path $PyRoot "python.exe"))) {
    Write-Err "PBS 布局异常: python.exe 不在 runtime 根 ($PyRoot)，请核查 uv 版本/变体"
  }
  Remove-Item Env:\UV_PYTHON_INSTALL_DIR

  Copy-Item $PyRoot $PyRtDir -Recurse -Force

  # 冒烟：用内置 Python 真建一个 venv（含 ensurepip），确认离线自洽
  $smoke = Join-Path $BuildDir "py-runtime-smoke"
  if (Test-Path $smoke) { Remove-Item $smoke -Recurse -Force }
  & (Join-Path $PyRtDir "python.exe") -m venv $smoke
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $smoke "Scripts\python.exe"))) {
    Write-Err "内置 Python 无法创建 venv —— 打包终止"
  }
  Remove-Item $smoke -Recurse -Force
  $rtMB = [math]::Round((Get-ChildItem $PyRtDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
  Write-OK "内置 Python runtime 就绪: $PyRtDir ($rtMB MB; 创建 venv 冒烟通过)"

  # ── 拓扑引擎资源 (drawing-engine/) + 内置 Node runtime（topology capability provider 用）──
  #
  # 图标库原先是顶层的 topology-icons/，在这里单独拷一步。那时有条硬约束：**图标必须排在
  # 引擎之前**，因为 icons.js 用 __dirname/../topology-icons/catalog.json 定位图标，而下面
  # 的冒烟每条命令都会走 resolveIconsForModel()，顺序反了就稳定 ENOENT——此前正是反的，
  # 冒烟一直是坏的。
  #
  # 图标已并进 drawing-engine/topology-icons/，跟着整目录一起拷，这条顺序约束随之消失：
  # 拷不全是"引擎没拷完整"，而不再是"两步的先后写错了"。
  # 只在开发仓库里存在 drawing-engine/ 时才打——不是每次发布都要带这个功能。
  $topoSrc = Join-Path $Root "drawing-engine"
  if (Test-Path $topoSrc) {
    Write-Step "绘图引擎资源 (drawing-engine/) + 内置 Node runtime"

    # node_modules 不入版本库，全新 checkout（尤其 CI：.github/workflows/build-win.yml 跑的
    # 就是本脚本）里不存在。不先装的话，下面那条 node_modules\elkjs 探针会 Write-Err → exit 1，
    # CI 每次都红。跟前端目录同样处理：缺了就装。
    # 用 npm ci 而不是 npm install：package-lock.json 已入库，ci 严格按锁文件装、装完可复现，
    # 且锁文件与 package.json 不一致时会直接失败而不是悄悄改锁文件。
    if (-not (Test-Path (Join-Path $topoSrc "node_modules"))) {
      Write-Host "  安装绘图引擎依赖 (npm ci in drawing-engine/)..."
      $r = Start-Process npm.cmd -ArgumentList "ci" -WorkingDirectory $topoSrc -NoNewWindow -Wait -PassThru
      if ($r.ExitCode -ne 0) { Write-Err "drawing-engine npm ci 失败" }
      Write-OK "绘图引擎依赖已安装"
    }

    # 2026-07-25：从"手工列出要拷哪几个文件"改成"整目录拷 + 排除开发产物"。
    # 原来这里写死 @("cli.js","topo.js","drc.js") 并注释"零 npm 依赖，不用带 node_modules"，
    # 早就不成立了：cli.js 现在还 require render.js/icons.js/geometry-report.js/draw-core.js，
    # topo.js require regions.js，而缺省的 orthogonal 走线要动态 import geometry-elk.mjs
    # ——后者依赖 node_modules 里的 elkjs + @mr_mint/elkjs-libavoid。照旧清单打出来的包
    # 一跑就 MODULE_NOT_FOUND，而构建期一声不吭。
    # 手工维护白名单是本项目反复踩的同一个坑（iconTheme 字段白名单、图例字段白名单、
    # 两引擎 cfg 字面量、这份打包清单），共同病根是"新增东西不改清单，构建照样成功"。
    # 所以清单这个做法本身就废掉：拷整个目录、带上 node_modules（package.json 无
    # devDependencies，依赖全是生产依赖，9MB 左右），漏没漏交给下面的三命令冒烟兜底。
    $topoDst = Join-Path $resDst "drawing-engine"
    if (Test-Path $topoDst) { Remove-Item $topoDst -Recurse -Force }
    Copy-Item $topoSrc $topoDst -Recurse -Force

    # 排除开发产物（自测脚本、样例模型、调试网页、npm 锁文件）。这是**排除**清单不是包含
    # 清单，两者失效方式相反：漏排除只是多带几 KB 死文件，漏包含则是包直接跑不起来。
    # 反着做（先整拷再删）而不是 Copy-Item -Exclude：-Exclude 配 -Recurse 在 PowerShell 5.1
    # 里只对顶层匹配生效，子目录会被漏掉，是个已知坑。
    # 只删顶层：node_modules 内部的同名文件（依赖自带的 .html/.json 等）一律不碰。
    foreach ($pat in @("verify*.js", "verify*.mjs", "*.topo.json", "*.html", "package-lock.json")) {
      Get-ChildItem $topoDst -Filter $pat -File -ErrorAction SilentlyContinue | Remove-Item -Force
    }
    foreach ($dir in @(".claude", ".git")) {
      $dp = Join-Path $topoDst $dir
      if (Test-Path $dp) { Remove-Item $dp -Recurse -Force }
    }

    # 拷完的存在性抽查。注意它跟原来的白名单性质不同：这不是"要拷哪些"的来源（来源是
    # 整目录拷贝），只是几个高价值探针，防止 drawing-engine/ 被误删空或 node_modules
    # 没装就打包。真正兜底漏文件的是下面的冒烟——探针漏写不会让坏包溜过去。
    foreach ($probe in @("cli.js", "draw-core.js", "regions.js", "node_modules\elkjs", "topology-icons\catalog.json")) {
      if (-not (Test-Path (Join-Path $topoDst $probe))) {
        Write-Err "拓扑引擎打包不完整：$topoDst\$probe 不存在（drawing-engine/ 里是不是没跑过 npm install？）"
      }
    }
    # 图标数量单独查一下：catalog.json 在不代表 svg 都在，而少了图标不会报错，只是画出来
    # 的拓扑图上设备变成空框——那种错要等用户看图才发现。基线 35 blue + 31 yellow = 66。
    $iconCount = (Get-ChildItem (Join-Path $topoDst "topology-icons\svg") -Recurse -File -Filter "*.svg" -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($iconCount -lt 30) { Write-Err "图标库打包看起来不完整：只找到 $iconCount 个 svg 文件" }
    $topoMB = [math]::Round((Get-ChildItem $topoDst -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
    Write-OK "拓扑引擎代码已输出到 $topoDst（含 node_modules 与 $iconCount 个图标，$topoMB MB）"

    $NodeVersion = "24.13.1"              # 与开发环境对齐；改版本只动这一行
    $NodeRtDir   = Join-Path $DistDir "node-runtime"
    if (Test-Path $NodeRtDir) { Remove-Item $NodeRtDir -Recurse -Force }
    New-Item -ItemType Directory -Force $NodeRtDir | Out-Null

    # 下载/缓存官方 Node 发行包，只取 node.exe——单文件可独立运行，不需要 npm/npx 等其余内容。
    $NodeCache = Join-Path $BuildDir "node-runtime-cache"
    New-Item -ItemType Directory -Force $NodeCache | Out-Null
    $NodeZip = Join-Path $NodeCache "node-v$NodeVersion-win-x64.zip"
    if (-not (Test-Path $NodeZip)) {
      $NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
      Write-Host "  下载 $NodeUrl ..."
      Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip
      if (-not (Test-Path $NodeZip)) { Write-Err "下载 Node runtime 失败: $NodeUrl" }
    } else {
      Write-Host "  复用缓存的 Node runtime 压缩包: $NodeZip"
    }

    $NodeExtract = Join-Path $NodeCache "extract"
    if (Test-Path $NodeExtract) { Remove-Item $NodeExtract -Recurse -Force }
    Expand-Archive -Path $NodeZip -DestinationPath $NodeExtract -Force

    $NodeExeSrc = Join-Path $NodeExtract "node-v$NodeVersion-win-x64\node.exe"
    if (-not (Test-Path $NodeExeSrc)) { Write-Err "解压后找不到 node.exe: $NodeExeSrc" }
    Copy-Item $NodeExeSrc (Join-Path $NodeRtDir "node.exe") -Force

    # ── 冒烟：内置 node.exe 真跑一遍打好的包里的 cli.js ──────────────────────────
    # 三个子命令全跑。这是上面"不再维护文件白名单"的兜底：少拷任何一个被 require 的文件
    # （或者 node_modules 没进来），必须在这里当场炸出来，而不是到用户机上 MODULE_NOT_FOUND。
    # 跑的是 $topoDst（包里那份）而不是源目录——测源目录等于什么都没测。
    $NodeExe = Join-Path $NodeRtDir "node.exe"
    $TopoCli = Join-Path $topoDst "cli.js"
    $smokeInput = '{"meta":{"name":"smoke"},"encoding":{"deviceRoles":{"x":{"w":80,"h":46,"fill":"#eef2fb","stroke":"#6b83c9","glyph":"switch","legend":"X"}},"linkTypes":{"t":{"stroke":"#5b6b7c","width":1.6,"dash":null,"bundle":1,"legend":"T"}},"connTypes":{}},"devices":[{"id":"A","role":"x","tier":0,"label":"A"},{"id":"B","role":"x","tier":1,"label":"B"}],"links":[{"a":"A","b":"B","type":"t"}]}'
    $smokeIn  = Join-Path $BuildDir "topo-smoke-in.json"
    $smokeLog = Join-Path $BuildDir "topo-smoke-out.txt"
    $smokeErr = Join-Path $BuildDir "topo-smoke-err.txt"
    # 无 BOM 写盘。stdin 走"临时文件 + Start-Process 重定向"，**不能**用 PowerShell 管道
    # （`$json | & node.exe …`）：PS 5.1 往原生进程 stdin 写字符串用的是 [Console]::InputEncoding，
    # 控制台代码页为 UTF-8 时（chcp 65001 / Win11「Beta: 使用 Unicode UTF-8」打开后即是）它带
    # BOM，cli.js 读到的第一个字符是 ﻿、JSON.parse 当场失败，整个构建被一条看不懂的
    # INVALID_JSON 挡死——且只在部分机器上复现。文件重定向是字节级的，与代码页无关。
    [System.IO.File]::WriteAllText($smokeIn, $smokeInput, (New-Object System.Text.UTF8Encoding($false)))

    # 同时收 stderr：漏文件时 cli.js 根本来不及 require 完，stdout 是空的，报错全在 stderr
    # （MODULE_NOT_FOUND 栈）。不收的话构建日志只剩一句"冒烟失败: "，等于没说。
    function Invoke-TopoSmoke([string[]]$CliArgs) {
      # 路径可能含空格，逐个加引号——Start-Process -ArgumentList 在 PS 5.1 里是原样空格拼接。
      $argList = @("`"$TopoCli`"") + $CliArgs
      $p = Start-Process $NodeExe -ArgumentList $argList -NoNewWindow -Wait -PassThru `
             -RedirectStandardInput $smokeIn -RedirectStandardOutput $smokeLog -RedirectStandardError $smokeErr
      $txt = ""
      if (Test-Path $smokeLog) { $txt = [string](Get-Content $smokeLog -Raw -Encoding UTF8) }
      $er = ""
      if (Test-Path $smokeErr) { $er = [string](Get-Content $smokeErr -Raw -Encoding UTF8) }
      return [pscustomobject]@{ Code = $p.ExitCode; Out = $txt; Err = $er }
    }

    # 1) draw --routing=direct：落盘预览 HTML + 返回诊断。observe/render 已于 2026-07-28
    #    合并进 draw（见 2026-07-28-topology-skill-and-tool-boundary-design.md）。
    $smokeHtml = Join-Path $BuildDir "topo-smoke-draw.html"
    if (Test-Path $smokeHtml) { Remove-Item $smokeHtml -Force }
    $r = Invoke-TopoSmoke @("draw", "`"--out=$smokeHtml`"", "--routing=direct")
    if ($r.Code -ne 0 -or -not ($r.Out -match '"score"')) {
      Write-Err "冒烟失败 cli.js draw --routing=direct (exit $($r.Code)): $($r.Out)$($r.Err)"
    }
    # draw 只回传路径和诊断，HTML 正文不该出现在 stdout 里（原 render_html 把 163KB 塞进
    # 返回值，触发 spill、逼 agent 用 shell 搬文件、弹权限审批）。
    if ($r.Out -match '"html"') {
      Write-Err "冒烟失败：draw 的返回值里出现了 HTML 正文，应该只回传 path/bytes"
    }
    if (-not (Test-Path $smokeHtml)) {
      Write-Err "冒烟失败：draw 没落出预览 HTML ($smokeHtml)"
    }
    # 顺带确认几何真的前移到了 Node——HTML 里不该再出现布局代码（浏览器只做平移缩放）。
    $htmlTxt = [string](Get-Content $smokeHtml -Raw -Encoding UTF8)
    if ($htmlTxt -match 'function computeLayout') {
      Write-Err "冒烟失败：draw 产出的 HTML 里仍内嵌布局代码（几何应已全部前移到 Node）"
    }
    Remove-Item $smokeHtml -Force

    # 3) export --format=svg：落盘一个真文件，确认内容是自包含 SVG
    $smokeSvg = Join-Path $BuildDir "topo-smoke-export.svg"
    if (Test-Path $smokeSvg) { Remove-Item $smokeSvg -Force }
    $r = Invoke-TopoSmoke @("export", "--format=svg", "`"--out=$smokeSvg`"", "--routing=direct")
    if ($r.Code -ne 0 -or -not ($r.Out -match '"bytes"')) {
      Write-Err "冒烟失败 cli.js export --format=svg (exit $($r.Code)): $($r.Out)$($r.Err)"
    }
    if (-not (Test-Path $smokeSvg) -or -not ([string](Get-Content $smokeSvg -Raw -Encoding UTF8)).StartsWith("<svg ")) {
      Write-Err "冒烟失败：export 没落出合法的 .svg 文件 ($smokeSvg)"
    }
    Remove-Item $smokeSvg -Force

    # 4) orthogonal 必须被明确拒绝（2026-07-28 起只开放 direct）。
    #    注意覆盖损失：这条以前是唯一会动态 import geometry-elk.mjs、从而证明 node_modules
    #    （elkjs + libavoid WASM）真被打进包的检查。orthogonal 关闭后没有任何冒烟会走到那条
    #    路径，node_modules 是否完整只剩上面 $probe 那个静态目录探测兜底。等 orthogonal 重新
    #    开放时，务必把这条改回"真的跑一遍并断言出图成功"。
    $r = Invoke-TopoSmoke @("draw", "`"--out=$smokeHtml`"", "--routing=orthogonal")
    if ($r.Code -eq 0 -or -not ($r.Out -match 'BAD_ARGS')) {
      Write-Err "冒烟失败：orthogonal 应当被拒绝（当前只开放 direct），实际 exit=$($r.Code): $($r.Out)$($r.Err)"
    }
    if (Test-Path $smokeHtml) { Remove-Item $smokeHtml -Force }

    Remove-Item $smokeIn, $smokeLog, $smokeErr -Force -ErrorAction SilentlyContinue
    Write-OK "内置 Node runtime 就绪: $NodeRtDir（draw/export 冒烟通过；orthogonal 已按预期拒绝）"
  } else {
    Write-Warn "drawing-engine/ 不存在，跳过拓扑引擎打包（该功能本次不随包）"
  }

  # ── browser-mcp（随包默认 MCP server，stdio 起）───────────────────────────────
  # 只在开发仓库里存在 browser-mcp/ 时才打。产物落到 exe 同级 resources/browser-mcp，
  # 与 resources/drawing-engine 并列；main.js 播种 mcp.json 时把占位符换成这个绝对路径。
  $bmSrc = Join-Path $Root "browser-mcp"
  if (Test-Path $bmSrc) {
    Write-Step "browser-mcp（随包 MCP server）"

    # dist/ 是 tsc 产物、不入版本库（.gitignore），全新 checkout / CI 里必须现建。
    # 用 npm ci 而非 install：锁文件已入库，装完可复现，且与 package.json 不一致会直接失败。
    if (-not (Test-Path (Join-Path $bmSrc "node_modules"))) {
      Write-Host "  安装 browser-mcp 依赖 (npm ci)..."
      $r = Start-Process npm.cmd -ArgumentList "ci" -WorkingDirectory $bmSrc -NoNewWindow -Wait -PassThru
      if ($r.ExitCode -ne 0) { Write-Err "browser-mcp npm ci 失败" }
    }
    $r = Start-Process npm.cmd -ArgumentList "run","build" -WorkingDirectory $bmSrc -NoNewWindow -Wait -PassThru
    if ($r.ExitCode -ne 0) { Write-Err "browser-mcp 构建失败 (tsc)" }

    # 只拷运行期要的：dist + package.json（ESM 靠它的 "type":"module" 才认 .js 为模块）
    # + 锁文件 + README。src/test/tsconfig 是开发物，不入包。
    $bmDst = Join-Path $resDst "browser-mcp"
    if (Test-Path $bmDst) { Remove-Item $bmDst -Recurse -Force }
    New-Item -ItemType Directory -Force $bmDst | Out-Null
    Copy-Item (Join-Path $bmSrc "dist") (Join-Path $bmDst "dist") -Recurse -Force
    foreach ($f in @("package.json","package-lock.json","README.md")) {
      Copy-Item (Join-Path $bmSrc $f) (Join-Path $bmDst $f) -Force
    }

    # 生产依赖装到**包里那份**：开发目录的 node_modules 含 typescript/@types（~59MB），
    # 运行期只要 @modelcontextprotocol/sdk + ws（~7MB）。--omit=dev 现装最干净。
    $r = Start-Process npm.cmd -ArgumentList "ci","--omit=dev","--ignore-scripts" -WorkingDirectory $bmDst -NoNewWindow -Wait -PassThru
    if ($r.ExitCode -ne 0) { Write-Err "browser-mcp 生产依赖安装失败 (npm ci --omit=dev)" }

    foreach ($probe in @("dist\index.js","package.json","node_modules\@modelcontextprotocol\sdk","node_modules\ws")) {
      if (-not (Test-Path (Join-Path $bmDst $probe))) {
        Write-Err "browser-mcp 打包不完整：$bmDst\$probe 不存在"
      }
    }

    # 起它要 node。**当前复用 drawing-engine 那份内置 runtime**——两者本不该耦合：
    # node-runtime 的下载/拷贝写在上面 drawing-engine 的 if 块里，哪天"这次发布不带拓扑"
    # 就会连带把 node.exe 拿掉，浏览器自动化跟着哑掉。这里显式检查并让构建当场失败，
    # 把静默失效变成硬报错；等 Node runtime 提到该 if 块之外后，这段检查可以去掉。
    $bmNode = Join-Path (Join-Path $DistDir "node-runtime") "node.exe"
    if (-not (Test-Path $bmNode)) {
      Write-Err "browser-mcp 需要内置 Node（$bmNode），但它当前由 drawing-engine/ 那段负责下载——drawing-engine/ 不在或未打包时就会缺。请先把 Node runtime 步骤提到 drawing-engine 的条件之外。"
    }

    # 冒烟：用内置 node 真跑一次 MCP 握手（initialize），确认依赖齐、能应答。
    # 只查 dist/ 在不在是不够的——少一个生产依赖同样过探针，却要到用户机上才 MODULE_NOT_FOUND。
    $bmIn  = Join-Path $BuildDir "bm-smoke-in.txt"
    $bmOut = Join-Path $BuildDir "bm-smoke-out.txt"
    $bmErr = Join-Path $BuildDir "bm-smoke-err.txt"
    $initReq = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"build-smoke","version":"0"}}}'
    # 无 BOM 写盘 + 文件重定向（理由同上面拓扑冒烟：PS 5.1 管道会按控制台代码页加 BOM）。
    [System.IO.File]::WriteAllText($bmIn, $initReq + "`n", (New-Object System.Text.UTF8Encoding($false)))
    $bmProc = Start-Process $bmNode -ArgumentList @("`"$(Join-Path $bmDst 'dist\index.js')`"") -NoNewWindow -PassThru `
                -RedirectStandardInput $bmIn -RedirectStandardOutput $bmOut -RedirectStandardError $bmErr
    # stdio server 应答后不会自己退出（等后续请求），所以给足时间再收工。
    if (-not $bmProc.WaitForExit(15000)) { $bmProc.Kill(); $bmProc.WaitForExit() }
    $bmTxt = ""
    if (Test-Path $bmOut) { $bmTxt = [string](Get-Content $bmOut -Raw -Encoding UTF8) }
    $bmErrTxt = ""
    if (Test-Path $bmErr) { $bmErrTxt = [string](Get-Content $bmErr -Raw -Encoding UTF8) }
    if ($bmTxt -notmatch '"serverInfo"') {
      Write-Err "browser-mcp 冒烟失败：initialize 没拿到应答。stdout=$bmTxt stderr=$bmErrTxt"
    }
    Remove-Item $bmIn, $bmOut, $bmErr -Force -ErrorAction SilentlyContinue

    $bmMB = [math]::Round((Get-ChildItem $bmDst -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
    Write-OK "browser-mcp 已输出到 $bmDst（含生产依赖，$bmMB MB；MCP initialize 冒烟通过）"
  } else {
    Write-Warn "browser-mcp/ 不存在，跳过随包 MCP 打包（该功能本次不随包）"
  }
} else {
  if (-not (Test-Path (Join-Path $DistDir "$($Branding.backendName).exe"))) {
    Write-Err "$($Branding.backendName).exe 不存在，请去掉 -SkipBackend 或先打后端"
  }
  Write-Warn "跳过后端打包"
}

# ── 3. winCodeSign 缓存修复（非 Admin 无法创建 macOS 符号链接）─────────────────
Write-Step "检查 winCodeSign 缓存"
$wcsDir   = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
$wcsCache = Join-Path $wcsDir "winCodeSign-2.6.0"
if ((Test-Path $wcsDir) -and -not (Test-Path $wcsCache)) {
  $tmpDir = Get-ChildItem $wcsDir -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d+$' } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($tmpDir) {
    $libDir = Join-Path $tmpDir.FullName "darwin\10.12\lib"
    New-Item -ItemType Directory -Force -Path $libDir | Out-Null
    foreach ($f in @("libcrypto.dylib","libssl.dylib")) {
      $fp = Join-Path $libDir $f
      if (-not (Test-Path $fp)) { New-Item -ItemType File -Force -Path $fp | Out-Null }
    }
    Rename-Item -Path $tmpDir.FullName -NewName "winCodeSign-2.6.0"
    Write-OK "winCodeSign 缓存已修复"
  }
}

# ── 4. electron-builder 打包 ──────────────────────────────────────────────────
Write-Step "electron-builder 打包 (NSIS)"
$electronDir = Join-Path $Root "electron"
if (-not (Test-Path (Join-Path $electronDir "node_modules"))) {
  Write-Host "  安装 electron 依赖 (npm install)..."
  $r = Start-Process npm.cmd -ArgumentList "install" -WorkingDirectory $electronDir -NoNewWindow -Wait -PassThru
  if ($r.ExitCode -ne 0) { Write-Err "electron npm install 失败" }
}
$r = Start-Process npm.cmd -ArgumentList "run","build" -WorkingDirectory $electronDir -NoNewWindow -Wait -PassThru
if ($r.ExitCode -ne 0) { Write-Err "electron-builder 打包失败" }

# ── 5. 产物检查 ───────────────────────────────────────────────────────────────
Write-Step "产物"
Get-ChildItem $outDir -Filter "*.exe" -ErrorAction SilentlyContinue |
  Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,1)}}, LastWriteTime |
  Format-Table -AutoSize
Write-OK "完成。三件套（Setup.exe + .blockmap + latest.yml）在 $outDir"
Write-Warn "发布前按 docs/release-runbook.md 校验 latest.yml 与 sha512。"


