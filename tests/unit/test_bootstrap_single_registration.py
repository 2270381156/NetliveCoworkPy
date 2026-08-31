"""装配根只有一处：同名 capability provider 不能出现两个。

背景：以前 cli 装一遍、FastAPI 的 lifespan 又装一遍，local_skill 和 topology 各有两个同名
实例，配置还不一样（一个带 bash_runner、一个不带）。registry 是 append 不去重也不告警，
下游四个索引对同名 provider 的取舍口径又不一致（skill 执行索引先注册赢，gateway/prompt/
定义加载后注册赢），于是"哪一份在干活"取决于问谁。这组测试把"只装一次"钉死。
"""

from __future__ import annotations

from types import SimpleNamespace

from netlivecowork.bootstrap import build_host_runtime


def _names(hr) -> list[str]:
    return [p.name for p in hr.core.providers.get_capability_providers()]


def test_no_duplicate_provider_names() -> None:
    hr = build_host_runtime(SimpleNamespace(enable_tools=True, skills_dir=None))
    names = _names(hr)
    dupes = {n for n in names if names.count(n) > 1}
    assert not dupes, f"同名 provider 注册了不止一次：{dupes}"


def test_no_duplicate_provider_names_without_tools() -> None:
    # 关掉 fs 工具这条支路也不能漏出重复（webview/agent/skill_executor 仍在）
    hr = build_host_runtime(SimpleNamespace(enable_tools=False, skills_dir=None))
    names = _names(hr)
    assert len(names) == len(set(names))


def test_skill_provider_gets_bash_runner_when_fs_present() -> None:
    """skill 脚本必须经 fs:shell 执行。

    fs:shell 是工作区闸门、bash authorizer、以及自动模式下 Low 令牌与 Office broker 注入的
    唯一入口；没有 bash_runner 的 provider 会走 _exec_direct 直跑，等于没有边界。
    """
    hr = build_host_runtime(SimpleNamespace(enable_tools=True, skills_dir=None))
    skill_provs = [p for p in hr.core.providers.get_capability_providers()
                   if p.name == "local_skill"]
    assert skill_provs, "本地 skill provider 没注册上"
    assert all(p._bash_runner is not None for p in skill_provs)


def test_cloud_skill_provider_also_gets_bash_runner(monkeypatch) -> None:
    """云端 skill 和本地 skill 走同一条执行通道。

    云端 provider 的 _borrow_local 会把自己的 bash_runner 原样传给临时的 local provider；
    这里是 None 的话，exec_script 就落到 core 的 _exec_direct 直跑，绕过 fs:shell——
    自动模式下等于没有 Low 令牌、没有工作区闸门、也拿不到 Office broker。
    """
    from netlivecowork.api import deps

    monkeypatch.setattr(deps, "get_skill_market_service", lambda: object())
    hr = build_host_runtime(SimpleNamespace(enable_tools=True, skills_dir=None))
    provs = [p for p in hr.core.providers.get_capability_providers()
             if p.name in ("local_skill", "cloud_skill")]
    assert {p.name for p in provs} == {"local_skill", "cloud_skill"}
    assert all(p._bash_runner is not None for p in provs), \
        {p.name: p._bash_runner for p in provs}
