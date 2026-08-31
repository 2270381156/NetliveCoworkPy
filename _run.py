"""PyInstaller 打包入口。

只做一件事：把控制权交给唯一的入口 `netlivecowork.cli.main()`。冻结态与 dev 从此走同一条
路径（`cli.main` 里按 sys.frozen 分岔：bootstrap.frozen 的进程级预置、SPA 挂载、无参数时
默认 serve）。

这个文件必须存在且是个脚本，因为 PyInstaller 的 Analysis 只收脚本路径
（见 packaging/ipmaster-cowork.spec）；除此之外它不该有内容——以前它有 275 行，其中
`--office-broker` 拦截、.env 加载、日志配置、建 app 起 uvicorn 都和 cli 各写了一份，
改了一边忘了另一边的 bug 只有真打包才暴露。
"""

from netlivecowork.cli import main

if __name__ == "__main__":
    main()
