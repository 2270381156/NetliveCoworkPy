"""装与收回 —— 拿到 zip 之后的那一段。

与 zip 从哪来无关：真下发是"问云端要授权与版本 → 取包 → 摆进一个暂存目录"，
开发期由 `NLC_COWORK_PACKAGES_DIR` 指向一个本地目录当**假云端**（需求 C12）。
两者**共用这同一段安装代码**，区别只是 zip 从网络来还是从本地目录来 ——
否则等真接云端才发现问题。

继承自 demo/experimental 的 `cowork_install.py`，加了一步：**装之前先验签**。

顺序是有讲究的：``读包 → 验签 → 校验结构 → 比版本 → 解开``。
验签放在最前，是因为后面每一步都要读包里的内容，而**未经验证的内容不该被信任到
"拿它的 id 去决定装到哪个目录"这一步**。
"""
from __future__ import annotations

import json
import logging
import shutil
import zipfile
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

from . import signature
from .entitlement import Plan
from .manifest import MANIFEST_NAME, MASTER_ID

logger = logging.getLogger(__name__)

#: 四个 facet 必须自带（需求 A5/A6）。缺了运行期会被母版**静默补上** ——
#: 装得上也跑得动，但用的是母版那份，而你以为是它自带的。⇒ 只能挡在装之前。
REQUIRED_FILES = ("SOUL.md", "ROLE.md", "METADATA.md", "COMPACT.md")

#: 单包大小上限（需求 C14）。装一份"不知道多大"的东西，磁盘可能被一个坏包吃光。
MAX_PACKAGE_BYTES = 10 * 1024 * 1024


class CoworkPackageError(Exception):
    """包本身有问题（不是签名问题——那个用 SignatureError，两者要分开报）。"""


@dataclass(frozen=True)
class InstallResult:
    installed: dict[str, str] = field(default_factory=dict)   # id → 版本
    skipped: dict[str, str] = field(default_factory=dict)     # id → 版本（版本相同）
    removed: tuple[str, ...] = ()                             # 被收回的
    failed: dict[str, str] = field(default_factory=dict)      # id/文件名 → 原因（要能据此修包）

    @property
    def ok(self) -> bool:
        return not self.failed


# ── 读包 ──────────────────────────────────────────────────────────────────────

def _read_manifest(zf: zipfile.ZipFile) -> tuple[str, dict]:
    """找到 `<id>/cowork.json` 并解析，返回（顶层目录名, 清单）。"""
    names = [n for n in zf.namelist() if not n.endswith("/") and n != signature.SIGNATURE_ENTRY]
    if not names:
        raise CoworkPackageError("包是空的")
    tops = {n.split("/")[0] for n in names}
    if len(tops) != 1:
        # 顶层不唯一 ⇒ 解包后会在数据目录里散落多个条目，且无法判定这个包是谁。
        raise CoworkPackageError(f"顶层目录必须唯一，实际有 {sorted(tops)}")
    top = tops.pop()
    path = f"{top}/{MANIFEST_NAME}"
    if path not in names:
        raise CoworkPackageError(f"缺 {MANIFEST_NAME}")
    try:
        return top, json.loads(zf.read(path).decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise CoworkPackageError(f"{MANIFEST_NAME} 解析失败：{e}") from e


def inspect(data: bytes) -> tuple[str, str]:
    """验签 + 校验结构，返回 (id, 版本)。**不写盘。**

    这里只做**安装侧**必需的检查（能不能安全解开、是谁、哪一版、facet 齐不齐）。
    字段语义的完整校验在打包侧 —— 那时改包的人还在现场，报错有人看（需求 A7）。
    """
    if len(data) > MAX_PACKAGE_BYTES:
        raise CoworkPackageError(
            f"包太大（{len(data)} 字节 > 上限 {MAX_PACKAGE_BYTES}）"
        )
    if not zipfile.is_zipfile(BytesIO(data)):
        raise CoworkPackageError("不是有效的 ZIP")

    # ⚠ 验签在最前：后面每一步都要读包里的内容，而未经验证的内容不该被信任到
    # "拿它的 id 去决定装到哪个目录"这一步。
    signature.verify(data)

    with zipfile.ZipFile(BytesIO(data)) as zf:
        top, manifest = _read_manifest(zf)
        cid = str(manifest.get("id") or "")
        version = str(manifest.get("version") or "")
        if not cid or not version:
            raise CoworkPackageError("清单缺 id 或 version")
        if cid == MASTER_ID:
            raise CoworkPackageError(f"{MASTER_ID} 是母版，不是 cowork，不能作为套件下发")
        if cid != top:
            # 不一致的话，装出来的目录名与它自称的 id 不同，后续按 id 找目录会落空。
            raise CoworkPackageError(f"id={cid!r} 与顶层目录 {top!r} 不一致")
        names = set(zf.namelist())
        missing = [f for f in REQUIRED_FILES if f"{top}/{f}" not in names]
        if missing:
            raise CoworkPackageError(f"缺 facet 文件 {missing}")
    return cid, version


def scan(packages_dir: Path) -> tuple[dict[str, tuple[str, bytes]], dict[str, str]]:
    """扫一个目录，返回（每个 cowork 最新的那个包, 读不了的）。

    **同一个 cowork 有多个版本的包时显式取最新**（需求 C2）：正常下发一个 cowork 只给
    一个版本，但开发机上旧包会堆着（打包不删旧的）。不显式取最新的话，装哪个取决于
    文件名排序 ——「1.9.0」排在「1.10.0」后面，于是装上旧版本，而现象只是"改了没生效"。

    **单个包坏掉不影响其余**：一个坏包让全部 cowork 都装不上，会把"某个包打错了"
    放大成"这个人一个 cowork 都没有"，而那与"他没权限"长得一模一样。
    """
    packages_dir = Path(packages_dir)
    newest: dict[str, tuple[str, bytes]] = {}
    failed: dict[str, str] = {}
    if not packages_dir.is_dir():
        return newest, failed

    for zip_path in sorted(packages_dir.glob("*.zip")):
        try:
            data = zip_path.read_bytes()
            cid, version = inspect(data)
        except (CoworkPackageError, signature.SignatureError, OSError) as e:
            failed[zip_path.name] = str(e)
            logger.warning("cowork 套件读取失败 %s：%s", zip_path.name, e)
            continue
        have = newest.get(cid)
        if have is None or _version_key(version) > _version_key(have[0]):
            newest[cid] = (version, data)
    return newest, failed


def _version_key(v: str) -> tuple:
    """版本比较键，**只用于"多个包挑最新"**，不用于判断要不要装。

    要不要装一律用相等比较（见 entitlement.plan）——云端下发的版本是递增整数，
    管理员回滚时会变小。

    数字段按数值比、其余按字符串：「1.10.0」必须大于「1.9.0」，
    纯字符串比较会判反，而判反的表现是装了个旧版本、内容看着"没更新"。
    """
    return tuple((0, int(p)) if p.isdigit() else (1, p) for p in str(v).split("."))


# ── 写盘 ──────────────────────────────────────────────────────────────────────

def _extract(data: bytes, dest_root: Path, cowork_id: str) -> None:
    """解到 `dest_root/<id>/`，先清空旧的。

    **路径穿越必须挡住**（需求 E1）：zip 里的 `../` 会写到目标目录之外。
    判据用 `resolve()` 之后的实际路径，**不看字符串**——`a/../../b` 这种字符串检查容易漏。

    **先全部读出来再落盘**：解到一半失败会留下一个"装了一半"的目录，
    而那个目录看着是装好的（有清单、有部分文件），下次启动会被当成已装。
    """
    dest = dest_root / cowork_id
    dest_resolved = dest.resolve()
    staged: list[tuple[Path, bytes]] = []

    with zipfile.ZipFile(BytesIO(data)) as zf:
        prefix = f"{cowork_id}/"
        for member in zf.infolist():
            if member.is_dir():
                continue
            name = member.filename
            if not name.startswith(prefix):
                continue          # 签名条目等包根文件不进安装目录
            rel = name[len(prefix):]
            if not rel:
                continue
            target = dest / rel
            if not target.resolve().is_relative_to(dest_resolved):
                raise CoworkPackageError(f"包内含非法路径：{name}")
            staged.append((target, zf.read(name)))

    if dest.exists():
        shutil.rmtree(dest)
    for target, blob in staged:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)


def prune_to(target_dir: Path, keep_ids: set[str]) -> list[str]:
    """删掉不在 keep_ids 里的已装套件，返回被删的 id。**这是"权限收回"唯一的入口。**

    ⚠ 只在**清单取回成功之后**调用：拿不到清单就一律不动本地状态（需求 C5/C7），
    否则网络抖一下就把人家的套件全删了，比"今天没更新到"严重得多。
    这条约束由 `entitlement.plan` 保证（`entitled=None` 时 remove 为空）。

    母版永远保留：它不是 cowork，没有谁的权限能收回它，而历史会话与内部任务都靠它。

    **删的是能力，不是记录**：会话数据一条不动，它们会因为"套件没了"自动转只读；
    权限装回来又自动可用 —— 推导式，没有状态要维护（需求 E5/I4）。
    """
    target_dir = Path(target_dir)
    if not target_dir.is_dir():
        return []
    removed: list[str] = []
    for d in sorted(target_dir.iterdir()):
        if not d.is_dir() or d.name.startswith(".") or d.name == MASTER_ID:
            continue
        if d.name in keep_ids:
            continue
        try:
            shutil.rmtree(d)
        except OSError as e:
            # 删不掉只丢它自己：这个 cowork 还留着（多给了权限），但别的该删的照删。
            logger.warning("cowork 套件删除失败 %s：%s", d, e)
            continue
        removed.append(d.name)
    if removed:
        # ⚠ 这一步不可逆，且会连用户改过的提示词一起删（需求 C4）。必须留痕。
        logger.info("cowork：权限收回，已删除套件 %s", ", ".join(removed))
    return removed


def apply(plan_: Plan, packages: dict[str, tuple[str, bytes]], target_dir: Path) -> InstallResult:
    """执行一份对账结果。

    装与删分开算、一起做：`plan_` 说要做什么（纯逻辑，见 entitlement），
    这里只负责落到磁盘上。
    """
    target_dir = Path(target_dir)
    installed: dict[str, str] = {}
    failed: dict[str, str] = {}

    for cid, version in sorted(plan_.install.items()):
        pkg = packages.get(cid)
        if pkg is None:
            # 计划里有、包却不在手上。**这不算被收回**（需求 C9），只是这次没装上。
            failed[cid] = "计划要装但没有这个包"
            continue
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            _extract(pkg[1], target_dir, cid)
            installed[cid] = version
        except (CoworkPackageError, OSError) as e:
            failed[cid] = str(e)
            logger.warning("cowork 套件安装失败 %s：%s", cid, e)

    # 收回：只删 plan 点名的那几个。
    # **不传"该留哪些"而是按点名删**——传"该留哪些"的话，任何算漏的都会被当成"该删"，
    # 而算漏一个的代价是删掉用户改过的提示词，不可逆。
    removed: tuple[str, ...] = ()
    if plan_.remove:
        removed = tuple(_remove_ids(target_dir, plan_.remove))

    return InstallResult(
        installed=installed, skipped=dict(plan_.skip), removed=removed, failed=failed
    )


def _remove_ids(target_dir: Path, ids) -> list[str]:
    """按 id 点名删。母版永远不删，哪怕点到它。"""
    target_dir = Path(target_dir)
    removed: list[str] = []
    for cid in sorted(set(ids)):
        if cid == MASTER_ID:
            continue
        d = target_dir / cid
        if not d.is_dir():
            continue
        try:
            shutil.rmtree(d)
        except OSError as e:
            logger.warning("cowork 套件删除失败 %s：%s", d, e)
            continue
        removed.append(cid)
    if removed:
        # ⚠ 不可逆，且会连用户改过的提示词一起删（需求 C4）。必须留痕。
        logger.info("cowork：权限收回，已删除套件 %s", ", ".join(removed))
    return removed
