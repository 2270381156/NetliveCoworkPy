; 自定义 NSIS 片段（electron-builder 自动包含 buildResources/installer.nsh）。
;
; XGate 免密认证要求宿主进程名为 electron.exe，因此 win.executableName
; 不能使用产品名。electron-builder 默认又会用 executableName 生成安装目录，
; 所以这里单独恢复产品目录名，避免新装路径变成 ...\Programs\electron。
!ifdef APP_FILENAME
  !undef APP_FILENAME
!endif
!define APP_FILENAME "${PRODUCT_NAME}"
;
; 默认运行中检查会按映像名结束所有 electron.exe，可能误关其他 Electron 应用。
; 改为检查本产品安装目录中的新、旧可执行文件是否被占用：应用内更新会先正常
; 退出自身；手工覆盖安装则要求用户关闭本应用后重试，不结束任何同名外部进程。
!include "FileFunc.nsh"   ; ${GetTime}：给每行日志盖时间戳

; 安装日志落盘：把关键步骤 append 到 %TEMP%\NetLIVE-Cowork-install.log。
; 之前全是 DetailPrint / ExecToLog，只进安装界面的「显示详细信息」折叠框，不落盘：
; 卡死了手上没有证据文件，静默更新(/S)更是一字不留。看这个文件最后一行就知道卡在哪一步。
;
; 不用 NSIS 的 LogSet：那要 makensis 带 NSIS_CONFIG_LOG 编译，electron-builder 自带的
; 通常没有，LogSet 会静默失败。自己 FileOpen append 最稳。
; 只借 $9 且 Push/Pop 复原，绝不碰 $R1..$R9（卸载循环的游标）。
!macro _ipmcLog _msg
  ; 时间戳是排"慢/卡"的关键：没有它，死循环和"单纯慢"、PowerShell 挂起和"起得慢"
  ; 都分不出来。GetTime "" "L" 取本地当前时间；它写 $0..$6，故一并 Push/Pop 复原，
  ; 绝不外泄到 $R*（卸载循环的游标）。文件句柄借 $9。
  Push $9
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6   ; $0=日 $1=月 $2=年 $3=周几 $4=时 $5=分 $6=秒
  ClearErrors
  FileOpen $9 "$TEMP\NetLIVE-Cowork-install.log" a
  ${ifnot} ${errors}
    FileSeek $9 0 END
    FileWrite $9 "[$2-$1-$0 $4:$5:$6] ${_msg}$\r$\n"
    FileClose $9
  ${endif}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $9
!macroend

!macro _ipmcCheckExecutableUnlocked _path _result
  StrCpy ${_result} "1"
  ${if} ${FileExists} "${_path}"
    ClearErrors
    FileOpen $R7 "${_path}" a
    ${if} ${Errors}
      StrCpy ${_result} "0"
    ${else}
      FileClose $R7
    ${endif}
  ${endif}
!macroend

; 关掉**本安装目录下**跑着的进程。按可执行文件的完整路径筛，不按映像名：
; 映像名是 electron.exe，按名字杀会误伤机器上别的 Electron 应用（这正是不能用
; NSIS 默认做法的原因）。按路径筛则只命中本产品——主进程与它拉起的后端
; （$INSTDIR 下的 resources/backend/*.exe 也算）都在这个目录下。
;
; 先请求正常关闭（CloseMainWindow → 主进程走 before-quit，会把后端停干净），
; 等两秒再强杀剩下的。只强杀不请求的话，后端可能被留成孤儿进程占着端口。
!macro _ipmcCloseProcessesIn _dir
  ; ⚠ 两处容易写错：
  ;   1. 空集合上直接调 .CloseMainWindow() 会抛 MethodNotFound，而"安装时程序没开"
  ;      正是最常见的情况 —— 所以先判个数。
  ;   2. `$$p` 在 NSIS 里才输出字面量 `$p`；写成 `$p` 会被 NSIS 当成自己的变量吃掉。
  ;      `$INSTDIR` 则是真的要 NSIS 展开，故不转义。
  DetailPrint "关闭 ${_dir} 下的进程…"
  ; 一条 PowerShell 走完「找进程→请求正常退出→等 1.5s→强杀→等 0.5s→复检」，
  ; 并**自己**把两行带时间戳的结果写进同一个 install.log：
  ;   found N: name(pid), ...        ← 关之前找到哪些
  ;   still alive N: name(pid), ...  ← 关完还剩哪些（退出码 0 也可能没关干净，这里才看得出是谁锁着）
  ; 日志文本用 ASCII：PowerShell 命令行经 codepage 传递，中文易乱；写文件的中文由 NSIS 侧负责。
  ; $$ 是 NSIS 转义后的字面 $；${_dir}/$TEMP 要 NSIS 展开，故不转义（两者含空格也安全，均在单引号内）。
  !insertmacro _ipmcLog "[closeProc] ${_dir} : 交给 powershell 关闭并复检（详见下面 found / still alive 两行）"
  ; ⚠ 必须带 /TIMEOUT：这台机器上 powershell 冷启动要 ~25s，且实测第一次直接返回
  ; "error"（AppLocker/杀软拦住，脚本一行没跑）。没有超时上限时，一旦 powershell 被
  ; 策略挂起，nsExec 会无限等下去 —— 安装就"卡住不动"。给 45s 硬上限：到点就放弃这次
  ; 关闭，交给后面的 taskkill 兜底，绝不把整个安装拖死。超时的话 Pop 得到 "timeout"。
  nsExec::ExecToLog /TIMEOUT=45000 `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$log='$TEMP\NetLIVE-Cowork-install.log'; $$p=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '${_dir}\*' }); Add-Content -LiteralPath $$log -Value ('['+(Get-Date -Format 'HH:mm:ss')+'] [closeProc] found '+$$p.Count+': '+(($$p | ForEach-Object { $$_.Name+'('+$$_.Id+')' }) -join ', ')); if ($$p.Count) { [void]$$p.CloseMainWindow() }; Start-Sleep -Milliseconds 1500; $$p | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; $$s=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '${_dir}\*' }); Add-Content -LiteralPath $$log -Value ('['+(Get-Date -Format 'HH:mm:ss')+'] [closeProc] still alive '+$$s.Count+': '+(($$s | ForEach-Object { $$_.Name+'('+$$_.Id+')' }) -join ', '))"`
  Pop $R6
  !insertmacro _ipmcLog "[closeProc] ${_dir} : powershell 返回，退出码 $R6（timeout=超时放弃，交给 taskkill 兜底）"
  DetailPrint "  关闭并复检：退出码 $R6"
  Sleep 300
!macroend

!macro _ipmcCloseOwnProcesses
  !insertmacro _ipmcCloseProcessesIn "$INSTDIR"
!macroend

; ── 卸载前代 ────────────────────────────────────────────────────────────────
;
; NetLIVE Cowork 与上一代 IPMaster-Cowork 的 appId 不同，Windows 因此把它们当成
; 两个产品：两个快捷方式、两个卸载项、两份数据。用户升级之后旧的还在，**还能点开
; 继续对话**，而他不会知道那边的会话是另一套。所以装新的之前先把旧的卸干净。
;
; 按 DisplayName 找，而不是按 appId 拼注册表键名：键名由 electron-builder 的
; GUID 规则决定，那规则不在我们手里，哪天变了这段就静默失效。
;
; 卸载器默认**不删** %APPDATA%\IPMaster-Cowork（deleteAppDataOnUninstall 未开），
; 所以顺序是安全的：先卸旧 → 再装新 → 首次启动时 migrateLegacyAppData 迁数据。
!define IPMC_LEGACY_PRODUCT "IPMaster-Cowork"
!define IPMC_UNINST_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"

!macro _ipmcUninstallPredecessorIn _root
  StrCpy $R1 0
  ipmc_pred_loop_${_root}:
    EnumRegKey $R2 ${_root} "${IPMC_UNINST_ROOT}" $R1
    StrCmp $R2 "" ipmc_pred_done_${_root}
    IntOp $R1 $R1 + 1
    ReadRegStr $R3 ${_root} "${IPMC_UNINST_ROOT}\$R2" "DisplayName"
    ; ⚠ **按前缀比，不能用全等。** 实测注册表里写的是 "IPMaster-Cowork 0.5.6" ——
    ; electron-builder 会把版本号缀在 DisplayName 后面。全等匹配永远不成立，
    ; 而且**静默跳过**：安装照常完成，上一代原封不动留着，谁也不知道这段没跑。
    StrLen $R7 "${IPMC_LEGACY_PRODUCT}"
    StrCpy $R6 $R3 $R7
    StrCmp $R6 "${IPMC_LEGACY_PRODUCT}" 0 ipmc_pred_loop_${_root}

    ; 命中前代。先关它的进程——按安装目录筛，所以不必关心它的进程名叫什么
    ; （旧的是 IPMaster-Cowork.exe，新的是 electron.exe）。
    ReadRegStr $R4 ${_root} "${IPMC_UNINST_ROOT}\$R2" "InstallLocation"
    !insertmacro _ipmcLog "[predecessor] ${_root} 命中: $R3 (InstallLocation=$R4)"
    StrCmp $R4 "" +2 0
    !insertmacro _ipmcCloseProcessesIn "$R4"

    ; 再静默卸载。QuietUninstallString 里已经带了 /S。
    ReadRegStr $R5 ${_root} "${IPMC_UNINST_ROOT}\$R2" "QuietUninstallString"
    StrCmp $R5 "" +3 0
    DetailPrint "正在卸载上一代 ${IPMC_LEGACY_PRODUCT} …"
    !insertmacro _ipmcLog "[predecessor] ${_root} ExecWait 开始: $R5"
    ExecWait '$R5' $R6
    !insertmacro _ipmcLog "[predecessor] ${_root} ExecWait 返回码=$R6，即将从头重新枚举"

    ; 卸载会改注册表，枚举下标已经不可靠了——从头再来一遍。
    StrCpy $R1 0
    Goto ipmc_pred_loop_${_root}
  Goto ipmc_pred_end_${_root}
  ipmc_pred_done_${_root}:
    ; **没命中也要说。** 上一版这里什么都不打，而匹配条件恰好是错的
    ; （注册表里是 "IPMaster-Cowork 0.5.6"，带版本号后缀，全等匹配永不成立），
    ; 于是安装照常完成、上一代原封不动留着，日志里一个字都没有。
    DetailPrint "${_root}: 没找到上一代 ${IPMC_LEGACY_PRODUCT}（无需卸载）"
    !insertmacro _ipmcLog "[predecessor] ${_root} 枚举结束：未找到上一代（或已全部卸完）"
  ipmc_pred_end_${_root}:
!macroend

; 详细信息列表框默认展开。electron-builder 的 common.nsh 把它设成 ShowInstDetails nevershow
; （连「显示详细信息」按钮都没有，只剩一个进度条）。customHeader 在 common.nsh 之后展开
; （installer.nsi 里 !insertmacro customHeader 在 !include common.nsh 之后），故能覆盖它。
!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro customInit
  !insertmacro _ipmcLog "==== customInit 开始（卸载前代，进度页之前）===="
  ; 两个根都找：装"给所有用户"的在 HKLM，装"给当前用户"的在 HKCU。
  !insertmacro _ipmcUninstallPredecessorIn HKCU
  !insertmacro _ipmcUninstallPredecessorIn HKLM
  !insertmacro _ipmcLog "==== customInit 结束 ===="
!macroend

; 按映像名强制结束。**这是兜底手段，只在按路径精确关闭之后仍然锁着时才用。**
;
; 代价说清楚：可执行文件名是 electron.exe（XGate 免密认证要求宿主进程名如此），
; 所以这一下会连带结束机器上其它同样叫 electron.exe 的进程。上一代 IPMaster-Cowork
; 的可执行文件名是 IPMaster-Cowork.exe，独一无二，按名字杀没有这个问题——
; 换名之后风险才出现，上游因此改成了"只弹框、不动手"。
;
; 但"只弹框"把关闭这件事整个甩给了用户，而用户点完确定发现什么也没发生。
; 权衡之后仍然保留这一步：精确关闭已经先试过一轮，走到这里说明那条路没生效；
; 而叫 electron.exe 的进程在真实机器上很少见（VS Code 是 Code.exe、Slack 是
; slack.exe，各家都改了名）。
!macro _ipmcForceKillByImage
  ; 同样带 /TIMEOUT：受控机器上 taskkill 也可能被安全策略卡住不返回。15s 足够，
  ; 到点就往下走，绝不在这里无限等。
  nsExec::ExecToLog /TIMEOUT=15000 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $R6
  nsExec::ExecToLog /TIMEOUT=15000 'taskkill /F /T /IM "${PRODUCT_NAME}.exe"'
  Pop $R6
  Sleep 800
!macroend

!macro customCheckAppRunning
  ; ⚠ 日志文本里绝不能嵌 ${isUpdated} 之类 LogicLib 标志：!insertmacro 预处理阶段会把它
  ; 展开成带空格的多 token，撑破引号，报 "requires 1 parameter(s), passed 3"。运行时的
  ; $R* / $INSTDIR 才安全（预处理不展开）。要 isUpdated 就进到宏体里再判。
  ; $EXEFILE 盖在日志里，用来区分这次是外层安装器跑的，还是 uninstallOldVersion
  ; 用 ExecWait 拉起的**旧版卸载器**（old-uninstaller.exe）在跑我们同一段宏 ——
  ; 之前日志停在"结束"之后没有下文，正因为接手的是旧卸载器那个独立进程，看不出它卡哪。
  ; 有了这行，下次日志一眼就知道是谁在跑、卡在哪个进程。
  !insertmacro _ipmcLog "==== customCheckAppRunning 开始（宿主进程 $EXEFILE）===="
  ; electron-builder 在 install section 开头设了 SetDetailsPrint none（installSection.nsh），
  ; 把卸旧版 / 解压 / 写注册表 / 建快捷方式全部静音 → 用户只见一个进度条，
  ; 大文件解压时像卡死。这里改回 both：状态栏走文件名、列表框滚动明细，
  ; 像正常安装包。配合 customHeader 里的 ShowInstDetails show（覆盖 common.nsh
  ; 的 nevershow，让列表框真的显示出来）。
  SetDetailsPrint both
  ${if} ${isUpdated}
    Sleep 1000
  ${endif}

  ; 先按安装目录精确关一轮——能走通就不必动到映像名那一层。
  !insertmacro _ipmcCloseOwnProcesses

  ; ⚠ 重试次数上限：$R4 当计数器。
  ; 为什么非加不可 —— 这段宏在**静默卸载器**里也跑（uninstallOldVersion 用 /S 拉起旧卸载器，
  ; un.onInit 见 Silent 就调 customCheckAppRunning）。静默时下面的 MessageBox 走 /SD IDOK 自动
  ; 点确定 → 强杀 → 复检 → 若还锁着就 Goto 回来 …… 一旦某个文件被杀软句柄按住（这台受控机
  ; 上很可能），taskkill 永远解不开锁，就成了**无人可打断的死循环**：安装从此卡死不动，正是
  ; 用户遇到的现象。封顶后：到次数就记一笔日志、放弃这一步往下走，让内置安装段自己去撞
  ; "文件占用"并给出可诊断的报错，而不是无限空转。
  StrCpy $R4 0

  ipmc_check_app_running:
  !insertmacro _ipmcCheckExecutableUnlocked "$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R8
  !insertmacro _ipmcCheckExecutableUnlocked "$INSTDIR\${PRODUCT_NAME}.exe" $R9
  ${if} $R8 == "0"
  ${orIf} $R9 == "0"
    ; 文案与按钮必须对得上：这里是「确定/取消」，所以只说"确定"。
    ; 点确定 = 我们替他关，不是让他自己去关——那正是上一版被骂的地方。
    !insertmacro _ipmcLog "[checkAppRunning] 检测到仍在运行($INSTDIR)，弹框等待用户确认"
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
      "${PRODUCT_NAME} 正在运行，需要关闭后才能继续安装。$\r$\n$\r$\n\
点「确定」关闭它并继续安装。" \
      /SD IDOK IDOK ipmc_close_and_retry
    !insertmacro _ipmcLog "[checkAppRunning] 用户点了取消，退出安装"
    Quit

    ipmc_close_and_retry:
    IntOp $R4 $R4 + 1
    !insertmacro _ipmcLog "[checkAppRunning] 第 $R4 次强制关闭后重试"
    !insertmacro _ipmcCloseOwnProcesses
    !insertmacro _ipmcForceKillByImage
    !insertmacro _ipmcCheckExecutableUnlocked "$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R8
    !insertmacro _ipmcCheckExecutableUnlocked "$INSTDIR\${PRODUCT_NAME}.exe" $R9
    ${if} $R8 == "0"
    ${orIf} $R9 == "0"
      ; 还锁着。封顶前再试；到顶就放弃这一步往下走，绝不无限循环。
      ${if} $R4 < 3
        !insertmacro _ipmcLog "[checkAppRunning] 强杀后仍锁着，回到检测（第 $R4 次，上限 3）"
        Goto ipmc_check_app_running
      ${else}
        !insertmacro _ipmcLog "[checkAppRunning] 强杀 3 次仍锁着（多半被杀软句柄占着），放弃关闭、继续安装，交给内置安装段报文件占用"
      ${endif}
    ${endif}
  ${endif}
  !insertmacro _ipmcLog "==== customCheckAppRunning 结束（宿主进程 $EXEFILE，可执行文件解锁=R8:$R8 R9:$R9）===="
!macroend
;
; 目的：更新 / 覆盖安装时跳过"为此用户 / 为所有用户"安装类型选择页；
;       真·全新安装仍正常显示让用户选。不固定模式——沿用用户已有安装的模式。
;
; 背景：该页（multiUser 的 PAGE_INSTALL_MODE）【没有】被 electron-builder 的 skipPageIfUpdated
;       包裹，所以更新时也会弹（选目录页有 skipPageIfUpdated、更新时自动跳，唯独这页不跳）。
;       唯一能跳过它的办法是在官方钩子 customInstallMode 里把 $isForceMachineInstall /
;       $isForceCurrentInstall 置 1（见 multiUserUi.nsh 的 PAGE PRE 函数）。
;
; 判定用两个信号，命中任一即跳过：
;   1. ${isUpdated}：应用内自动更新时 electron-updater 一定带 --updated —— 更新路径的可靠信号。
;   2. 注册表 InstallLocation：本机已装过（HKLM=所有用户 / HKCU=当前用户）—— 手动覆盖装也能识别。
;      （$hasPerMachineInstallation / $hasPerUserInstallation 由 initMultiUser 在 .onInit 里读注册表填好。）
; 都不命中 = 真·全新安装 → 不 force → 正常显示选择页，用户自己选。
; 主安装段（解压文件 / 写注册表 / 建快捷方式）本身是 electron-builder/NSIS 内置的，
; 我们插不进去；但能在它**跑完后**盖一个边界。若日志停在 "customCheckAppRunning 结束"
; 而**没有**这一行，就说明卡在了内置安装段（磁盘满 / 杀软锁文件），而不是我们的逻辑。
!macro customInstall
  !insertmacro _ipmcLog "==== 文件安装完成（解压 + 写注册表 + 快捷方式 已过）===="
!macroend

!macro customInstallMode
  ${if} $hasPerMachineInstallation == "1"
    ; 已按"所有用户"装过 → 沿用 machine
    StrCpy $isForceMachineInstall "1"
  ${elseif} $hasPerUserInstallation == "1"
    ; 已按"当前用户"装过 → 沿用 user
    StrCpy $isForceCurrentInstall "1"
  ${elseif} ${isUpdated}
    ; 应用内更新但注册表没读到安装位置（旧版用别的 key 写的等）：
    ; 既然是更新就一定装过，按默认的 per-user 沿用并跳过，不再多弹一页。
    StrCpy $isForceCurrentInstall "1"
  ${endif}
!macroend
