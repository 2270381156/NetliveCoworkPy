# evals/ 使用指南

## 什么时候需要写 evals

满足以下任一条件，建议创建 evals/：

- Skill 的逻辑有多个分支，容易在改动后悄悄出错
- Skill 会被反复修改和迭代（比如规则经常更新）
- Skill 的输出有明确的「对/错」判断标准（不是主观评价）
- 用户反映过某个 case 之前出错过，希望以后不再出错

简单、一次性的 Skill 不需要 evals。

## evals/ 和 examples/ 的区别

| | examples/ | evals/ |
|--|-----------|--------|
| **用途** | 给 Claude 参考，知道好输出长什么样 | 改完 skill 后验证，检查有没有退化 |
| **使用时机** | 每次执行 skill 时 Claude 都会参考 | 只在测试/验证时使用 |
| **关注点** | 输出的风格和质量 | 输出的正确性 |

## evals 文件格式

每个用例一个文件，放在 `evals/` 目录下：

```markdown
# [测试场景名称]

## 输入

[给 Claude 的完整输入，包括用户说的话和所有附件内容]

## 期望输出

[理想情况下 Claude 应该输出什么，可以是关键点列表而不是完整输出]

## 判断标准

- [ ] [必须包含的内容或行为1]
- [ ] [必须包含的内容或行为2]
- [ ] [不应该出现的内容]

## 这个用例覆盖的场景

[一句话说明这个 case 是为了测试什么特殊情况]
```

## run_eval.py：让 evals 能真正跑起来

evals 文件本身是被动的——写完放在那儿不会自动执行。每个有 evals/ 目录的 skill，都应该在 `scripts/run_eval.py` 里有一个配套的运行脚本，否则 evals 只是备忘录。

**什么时候创建 run_eval.py：**
写进第一个 eval 文件时，同步创建 `scripts/run_eval.py`。如果已有，确认新 case 会被它覆盖到。

**run_eval.py 的职责：**
1. 读取 `evals/` 下所有 `.md` 文件
2. 解析每个文件的「输入」和「判断标准」
3. 用 `claude -p` 带上 skill 运行输入，拿到实际输出
4. 对照判断标准逐条打分（通过 / 不通过 / 无法自动判断）
5. 输出汇总结果，列出哪些 case 通过、哪些失败、失败的期望和实际输出各是什么

**基本结构：**

```python
# 功能：运行 evals/ 下所有测试用例，验证 skill 行为是否符合预期
# 用法：python scripts/run_eval.py --skill-path <skill目录路径>
# 输出：每个 case 的通过/失败状态，以及失败 case 的详情

import subprocess, pathlib, re, sys

def parse_eval(md_path):
    """解析 eval 文件，提取输入和判断标准"""
    ...

def run_case(skill_path, prompt):
    """调用 claude -p 执行单个 case"""
    result = subprocess.run(
        ["claude", "-p", prompt, "--skill", skill_path],
        capture_output=True, text=True
    )
    return result.stdout

def grade(output, criteria):
    """对照判断标准打分，返回 (passed, failed, manual) 三类"""
    ...

if __name__ == "__main__":
    ...
```

**判断标准的自动化程度：**
- 能用字符串匹配检查的（「输出必须包含X」「不应出现Y」）→ 脚本自动判断
- 需要语义理解的（「逻辑是否合理」「语气是否合适」）→ 标记为 `manual`，打印出来让人判断
- 不要为了让脚本跑通而把所有标准都降级成 `manual`

## 推荐的 evals 覆盖范围

| 优先级 | 场景类型 | 说明 |
|-------|---------|-----|
| 必须 | 典型正常场景 | 最常见的使用方式 |
| 必须 | 曾经出过错的场景 | 已知的历史问题，防止复发 |
| 推荐 | 输入不完整/信息缺失 | 用户没提供齐全信息时的行为 |
| 推荐 | 边界情况 | 极端输入、特殊格式 |
| 可选 | 异常输入 | 完全错误的输入，验证错误处理 |