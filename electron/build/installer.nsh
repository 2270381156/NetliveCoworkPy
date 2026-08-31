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
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$p = @(Get-Process -ErrorAction SilentlyContinue | Where-Object Path -like '${_dir}\*'); if ($$p.Count) { [void]$$p.CloseMainWindow() }"`
  Pop $R6
  Sleep 2000
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object Path -like '${_dir}\*' | Stop-Process -Force"`
  Pop $R6
  Sleep 500
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
    StrCmp $R3 "${IPMC_LEGACY_PRODUCT}" 0 ipmc_pred_loop_${_root}

    ; 命中前代。先关它的进程——按安装目录筛，所以不必关心它的进程名叫什么
    ; （旧的是 IPMaster-Cowork.exe，新的是 electron.exe）。
    ReadRegStr $R4 ${_root} "${IPMC_UNINST_ROOT}\$R2" "InstallLocation"
    StrCmp $R4 "" +2 0
    !insertmacro _ipmcCloseProcessesIn "$R4"

    ; 再静默卸载。QuietUninstallString 里已经带了 /S。
    ReadRegStr $R5 ${_root} "${IPMC_UNINST_ROOT}\$R2" "QuietUninstallString"
    StrCmp $R5 "" +3 0
    DetailPrint "正在卸载上一代 ${IPMC_LEGACY_PRODUCT} …"
    ExecWait '$R5' $R6

    ; 卸载会改注册表，枚举下标已经不可靠了——从头再来一遍。
    StrCpy $R1 0
    Goto ipmc_pred_loop_${_root}
  ipmc_pred_done_${_root}:
!macroend

!macro customInit
  ; 两个根都找：装"给所有用户"的在 HKLM，装"给当前用户"的在 HKCU。
  !insertmacro _ipmcUninstallPredecessorIn HKCU
  !insertmacro _ipmcUninstallPredecessorIn HKLM
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
  nsExec::ExecToLog 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $R6
  nsExec::ExecToLog 'taskkill /F /T /IM "${PRODUCT_NAME}.exe"'
  Pop $R6
  Sleep 800
!macroend

!macro customCheckAppRunning
  ${if} ${isUpdated}
    Sleep 1000
  ${endif}

  ; 先按安装目录精确关一轮——能走通就不必动到映像名那一层。
  !insertmacro _ipmcCloseOwnProcesses

  ipmc_check_app_running:
  !insertmacro _ipmcCheckExecutableUnlocked "$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R8
  !insertmacro _ipmcCheckExecutableUnlocked "$INSTDIR\${PRODUCT_NAME}.exe" $R9
  ${if} $R8 == "0"
  ${orIf} $R9 == "0"
    ; 文案与按钮必须对得上：这里是「确定/取消」，所以只说"确定"。
    ; 点确定 = 我们替他关，不是让他自己去关——那正是上一版被骂的地方。
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
      "${PRODUCT_NAME} 正在运行，需要关闭后才能继续安装。$\r$\n$\r$\n\
点「确定」关闭它并继续安装。" \
      /SD IDOK IDOK ipmc_close_and_retry
    Quit

    ipmc_close_and_retry:
    !insertmacro _ipmcCloseOwnProcesses
    !insertmacro _ipmcForceKillByImage
    !insertmacro _ipmcCheckExecutableUnlocked "$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R8
    !insertmacro _ipmcCheckExecutableUnlocked "$INSTDIR\${PRODUCT_NAME}.exe" $R9
    ${if} $R8 == "0"
    ${orIf} $R9 == "0"
      ; 还锁着说明连强杀都没解决（权限不足等）。再问一次，让用户有退出的余地，
      ; 不要闷头循环。
      Goto ipmc_check_app_running
    ${endif}
  ${endif}
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
