"""Host LLMProvider — subclasses the core provider to build host adapters.

Keeps the public name `LLMProvider` (and re-exports the core value types) so
existing host imports keep working; only `_build_adapter` is overridden.
"""

from __future__ import annotations

import logging

from ctx_weft.protocols import LLMClient
from ctx_weft.providers.llm import (  # noqa: F401
    LLMAccount,
    LLMProvider as _CoreLLMProvider,
    ModelConfig,
    SUPPORTED_STYLES,
)

logger = logging.getLogger(__name__)

#: 账号来源。**这是 `llm.allow` 的判据** —— 只有非 USER 的那批受套件声明约束。
ORIGIN_FACTORY = "factory"   # 随包出厂（default_llm_accounts.json）
ORIGIN_SUITE = "suite"       # cowork 套件下发（清单 llm.define）
ORIGIN_USER = "user"         # 用户自己注册的（缺省）


class LLMProvider(_CoreLLMProvider):
    """Host provider: builds host adapter subclasses (endpoint inference + SSL)."""

    def __init__(self, store, *, max_http_retries: int = 3, ssl_verify: bool | str = False) -> None:
        super().__init__(store, max_http_retries=max_http_retries)
        # SSL verification for outbound LLM HTTPS. Defaults to False so internal /
        # self-signed endpoints work out of the box; pass a CA-bundle path or True
        # to enforce verification.
        self._ssl_verify = ssl_verify
        # 每个账号**从哪来**。这是判据，不是 locked ——
        # locked 说的是"界面禁删禁改"（一个行为），来源说的是"这是谁的账号"。
        # 今天两者恰好重合，但拿 locked 当来源判据的话，哪天为别的理由锁一个账号，
        # 模型可见性会跟着悄悄变，且不报错。
        #
        #   ORIGIN_FACTORY  随包出厂（default_llm_accounts.json）
        #   ORIGIN_SUITE    cowork 套件下发（清单 llm.define）
        #   ORIGIN_USER     用户自己注册的 —— **他自己机器上的东西**（缺省）
        self._account_origin: dict[str, str] = {}
        # 随包/下发账号名集合：对用户【可见】（选择器显示真名、可选），但【锁定】
        # ——不可删、不可改（删改了就破坏了统一下发的官方默认）。
        self._locked_account_names: set[str] = set()

    def locked_account_names(self) -> set[str]:
        """随包默认账号名（界面可见、但禁止删除/编辑）。"""
        return set(self._locked_account_names)

    def mark_origin(self, name: str, origin: str) -> None:
        """记下这个账号从哪来，并按来源决定锁不锁。

        非用户来源的一律锁定（可见但禁删禁改）：改了也留不住 ——
        下次启动按种子/套件重来，给一个能改却改不动的入口比不给更糟。
        """
        if origin not in (ORIGIN_FACTORY, ORIGIN_SUITE, ORIGIN_USER):
            raise ValueError(f"未知的账号来源：{origin!r}")
        self._account_origin[name] = origin
        if origin != ORIGIN_USER:
            self._locked_account_names.add(name)

    def drop_accounts_of_origin(self, origin: str) -> list[str]:
        """撤掉某个来源的全部账号，返回撤掉的名字。

        **只动内存，不走 delete_account**：这些账号本来就 `persist=False`，
        而 `delete_account` 会顺手去删一个根本不存在的文件 —— 无害，但会把
        "账号库里到底有没有它"这件事搞混，将来查问题时多一层误导。

        三张表要一起清（账号 / adapter / 来源 / 锁定），漏一张的表现各不相同：
        漏 adapter 会留一个连得上的客户端，漏来源会让下次重建时它被当成"用户自己的"。
        """
        names = [n for n, o in self._account_origin.items() if o == origin]
        for n in names:
            self._accounts.pop(n, None)
            self._adapters.pop(n, None)
            self._account_origin.pop(n, None)
            self._locked_account_names.discard(n)
        if names:
            logger.info("LLMProvider: 撤掉来源为 %s 的账号 %s", origin, names)
        return names

    def account_origin(self, name: str) -> str:
        """这个账号从哪来。**没记过的一律算用户自己的** —— 存量账号本来就是他注册的。"""
        return self._account_origin.get(name, ORIGIN_USER)

    def managed_account_names(self) -> set[str]:
        """统一交付的那批（出厂 + 套件下发）。

        **`llm.allow` 只约束这一批**：用户自己配的账号是他自己机器上的东西，
        云端下发的一份清单没道理没收它（见 api/cowork_bridge.allowed_llm_accounts）。
        """
        return {n for n, o in self._account_origin.items() if o != ORIGIN_USER}

    def _build_adapter(self, account: LLMAccount) -> LLMClient:
        if account.style == "openai":
            from netlivecowork.providers.llm.adapters import HostOpenAIAdapter
            return HostOpenAIAdapter(
                api_key=account.api_key,
                base_url=account.base_url or "https://api.openai.com",
                timeout_sec=account.timeout_sec,
                max_http_retries=self._max_http_retries,
                ssl_verify=self._ssl_verify,
            )
        if account.style == "anthropic":
            from netlivecowork.providers.llm.adapters import HostAnthropicAdapter
            return HostAnthropicAdapter(
                api_key=account.api_key,
                base_url=account.base_url or "https://api.anthropic.com",
                timeout_sec=account.timeout_sec,
                max_http_retries=self._max_http_retries,
                ssl_verify=self._ssl_verify,
            )
        return super()._build_adapter(account)

    def bootstrap_from_seed(self, seed_path) -> None:
        """从随包扁平 JSON 种子注册默认账号（对用户可见、但锁定：显示真名可选、禁删禁改）。

        种子是 JSON 数组，每项一个账号一个模型，字段同原 NLC_LLM_*：
          account, style, api_key, base_url, model,
          context_limit, output_reserve, output_ceiling, timeout_sec
        api_key 支持明文或混淆密文（enc:v1:...，自动解密，见 providers/llm/secret.py）。
        output_reserve/output_ceiling 未设 = None → core 按窗口尺寸取默认 / 回退 context_limit。

        「有问题及时暴露」（fail-fast）：
          * 文件存在但 JSON 语法错、或某账号有 api_key 却字段非法（缺 account/style/model、
            style 不支持、key 解密失败）→ 抛错，启动即失败，不静默吞。
          * 某项 api_key 为空 = 未填模板 → 跳过并记日志（可见、不致命）。
          * 文件不存在 → 记日志后返回（dev 可无默认账号）。
        """
        import json
        from pathlib import Path

        from netlivecowork.providers.llm.secret import decrypt_key

        path = Path(seed_path)
        if not path.exists():
            logger.warning("LLMProvider: 默认账号种子不存在，跳过：%s", path)
            return
        try:
            entries = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise RuntimeError(f"默认 LLM 账号种子读取/解析失败：{path}：{e}") from e
        if not isinstance(entries, list):
            raise RuntimeError(f"默认 LLM 账号种子应为 JSON 数组：{path}")

        seeded = 0
        for i, e in enumerate(entries):
            if not isinstance(e, dict):
                raise RuntimeError(f"默认 LLM 账号种子第 {i} 项应为对象：{path}")
            name = str(e.get("account") or "").strip()
            api_key_raw = str(e.get("api_key") or "").strip()
            style = str(e.get("style") or "").strip()
            model = str(e.get("model") or "").strip()

            # 空 api_key = 未填模板 → 跳过（可见日志，不致命）
            if not api_key_raw:
                logger.info("LLMProvider: 默认账号第 %d 项 api_key 为空，视为未填模板，跳过", i)
                continue
            # 有 key 但字段不全/非法 → fail-fast
            if not name or not style or not model:
                raise RuntimeError(
                    f"默认 LLM 账号第 {i} 项字段缺失（account/style/model 必填）：{path}")
            if style not in SUPPORTED_STYLES:
                raise RuntimeError(
                    f"默认 LLM 账号 '{name}' style 不支持：{style}"
                    f"（支持 {sorted(SUPPORTED_STYLES)}）")
            try:
                api_key = decrypt_key(api_key_raw)
            except Exception as ex:  # 解密失败等 → 立即暴露
                raise RuntimeError(f"默认 LLM 账号 '{name}' api_key 解密失败：{ex}") from ex
            if not api_key:
                raise RuntimeError(f"默认 LLM 账号 '{name}' api_key 解密为空")
            if self.is_registered(name):
                logger.info("LLMProvider: 默认账号 '%s' 已存在同名注册，跳过种子", name)
                continue

            context_limit = int(e.get("context_limit") or 128000)
            _or = e.get("output_reserve")
            output_reserve = int(_or) if _or not in (None, "") else None
            _oc = e.get("output_ceiling")
            output_ceiling = int(_oc) if _oc not in (None, "") else None
            timeout_sec = int(e.get("timeout_sec") or 120)

            account = LLMAccount(
                name=name,
                style=style,
                api_key=api_key,
                base_url=str(e.get("base_url") or ""),
                models=[ModelConfig(name=model, context_limit=context_limit,
                                    output_reserve=output_reserve,
                                    output_ceiling=output_ceiling)],
                default_model=model,
                timeout_sec=timeout_sec,
            )
            self.register_account(account, persist=False)
            self.mark_origin(name, ORIGIN_FACTORY)   # 随包出厂 → 受管、锁定
            seeded += 1

        # 让默认账号稳定排在最前（回退目标 = accounts[0]/next(iter)），不受用户账号顺序影响。
        if self._locked_account_names:
            locked = {n: a for n, a in self._accounts.items()
                      if n in self._locked_account_names}
            others = {n: a for n, a in self._accounts.items()
                      if n not in self._locked_account_names}
            self._accounts = {**locked, **others}
        logger.info("LLMProvider: seeded %d default account(s) from %s", seeded, path)
