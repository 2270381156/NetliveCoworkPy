"""工作区的文件系统原语（纯路径与文件操作，不含 HTTP / 会话概念）。

上传、打包下载、删除这三件事都要在动文件之前先确认「这条路径是不是安全的」，而这个
判断放在 api/ 层就会被复制三遍——复制出来的第四遍迟早会漏掉一条，而漏掉的表现是
**能写到工作区之外**，静默且严重。所以收在这里，api/ 只负责把结果翻成 HTTP 状态码。

云端那份（demo/experimental 的同名模块）还管「按会话/按用户命名的目录在存储根下怎么
排布」。本分支的工作区是用户自己机器上的任意目录，由前端选、经 /workspace/draft-root
登记，没有"存储根"这个概念，故不搬那一半。
"""
from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path


def is_within(target: Path, root: Path) -> bool:
    """target 是否就是 root 或落在 root 之内（两者都应已 resolve）。"""
    return target == root or root in target.parents


def safe_upload_name(filename: str) -> str:
    """把浏览器给的文件名收敛成一个安全的**纯文件名**。

    只取 basename 并剔除路径分隔符，杜绝 `../../etc/passwd` 与 Windows 盘符写法；
    结果为空（比如文件名全是分隔符）时抛 ValueError，由调用方翻成 400。
    """
    raw = (filename or "").replace("\\", "/")
    name = os.path.basename(raw).strip().strip(".")
    if not name or name in (".", ".."):
        raise ValueError(f"illegal upload filename: {filename!r}")
    return name


def iter_files(root: Path) -> Iterator[tuple[Path, str]]:
    """递归产出 (绝对路径, 相对 root 的 posix 路径)，用于打包下载。

    不跟随符号链接：工作区是用户可写的，跟链接走等于把"打包这个目录"变成一条读取任意
    文件的通道。读不到的条目跳过，不让一个坏文件毁掉整包。
    """
    stack = [root]
    while stack:
        cur = stack.pop()
        try:
            entries = list(os.scandir(cur))
        except OSError:
            continue
        for de in entries:
            try:
                if de.is_dir(follow_symlinks=False):
                    stack.append(Path(de.path))
                elif de.is_file(follow_symlinks=False):
                    p = Path(de.path)
                    yield p, p.relative_to(root).as_posix()
            except OSError:
                continue


def directory_size(path: Path) -> int:
    """递归统计目录占用字节数；不跟随符号链接，读不到的条目跳过。

    目录很大时这是一次全量遍历，所以只在上传/打包这种低频路径上调用，别放进列目录。
    """
    total = 0
    stack = [path]
    while stack:
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for de in it:
                    try:
                        if de.is_dir(follow_symlinks=False):
                            stack.append(Path(de.path))
                        elif de.is_file(follow_symlinks=False):
                            total += de.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total
