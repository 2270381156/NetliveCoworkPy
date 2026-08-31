"""暂存目录 —— 主进程与后端之间那一手交接。

取包的是客户端主进程（用户令牌只在那儿），装的是后端（解包、验签、比版本的逻辑
只写一份）。两者之间摆一个目录：

    <暂存>/ipmaster-3.zip
           mbb-1.zip
           entitled.json      ← {"agents": ["ipmaster", "mbb"], "syncedAt": "..."}

## `entitled.json` 为什么必须有

它是**"该有哪几个"的唯一凭据**（需求 C4）。

不能让后端直接数目录里有几个 zip：**版本没变的根本不会下载**，那个 zip 不在目录里 ——
按目录判会把它当成被收回而删掉，于是每次启动都得重下一遍全部套件才能不被误删。

## 没有它的时候一个都不删

覆盖两种情形（需求 C5）：手工摆目录的开发态，以及这次对账没成功。
两种都不该导致删除 —— 前者是开发者故意的，后者是网络问题。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

ENTITLED_FILE = "entitled.json"


def write_entitled(staging_dir: Path, agent_ids) -> None:
    """写下"该有哪几个"。**只在对账成功之后调用。**"""
    staging_dir = Path(staging_dir)
    staging_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "agents": sorted(set(agent_ids)),
        "syncedAt": datetime.now(timezone.utc).isoformat(),
    }
    (staging_dir / ENTITLED_FILE).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def read_entitled(staging_dir: Path) -> frozenset[str] | None:
    """读"该有哪几个"。**读不到就返回 None，绝不返回空集合。**

    ⚠ 这个区别是本模块存在的全部意义：`None` 是"不知道"（一个都不删），
    空集合是"确实一个都没有"（全删）。搞混的代价是把用户的套件连同他改过的提示词
    删掉，且不可逆。
    """
    path = Path(staging_dir) / ENTITLED_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.info("cowork：没有可用的授权凭据（%s：%s）——这次一个都不删", path, e)
        return None
    if not isinstance(raw, dict):
        logger.warning("cowork：%s 顶层不是对象，当成没有凭据", path)
        return None
    agents = raw.get("agents")
    if not isinstance(agents, list):
        logger.warning("cowork：%s 里的 agents 不是数组，当成没有凭据", path)
        return None
    return frozenset(str(a).strip() for a in agents if str(a).strip())


def write_package(staging_dir: Path, agent_id: str, version: str, data: bytes) -> Path:
    """把一个包摆进暂存目录。文件名只为可读，**判定用的是包自报的 id**（需求 C10）。"""
    staging_dir = Path(staging_dir)
    staging_dir.mkdir(parents=True, exist_ok=True)
    path = staging_dir / f"{agent_id}-{version}.zip"
    path.write_bytes(data)
    return path
