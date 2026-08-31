# 标准目录结构

## 目录规范

```
[skill名称]/                    # 英文小写，单词之间用连字符
├── SKILL.md                   # 必须创建
├── references/                # 有领域知识时创建（Claude读的文档）
│   └── [主题].md              # 每类知识一个文件，文件名说明用途
├── templates/                 # 有固定输出格式时创建
│   └── [格式名].md
├── scripts/                   # 有自动化逻辑时创建
│   ├── [功能].py
│   └── README.md              # 有多个脚本时必须创建
├── assets/                    # 脚本要读取的数据文件时创建
│   └── [数据文件]             # .csv/.json/.yaml/.png 等，脚本引用
├── examples/                  # 有示例输出供Claude参考时创建
│   └── [案例名].md
└── evals/                     # 需要回归测试时创建
    └── [场景名].md            # 每个测试用例一个文件
```

## 命名规范

- 文件夹名：英文小写，连字符分隔，如 `cutover-plan-generator`
- references 里的文件：按内容命名，如 `scoring-rules.md`、`industry-standards.md`
- templates 里的文件：按输出类型命名，如 `report-template.md`、`config-template.yaml`
- scripts 里的文件：动词+对象，如 `parse_config.py`、`generate_report.py`
- assets 里的文件：按数据内容命名，如 `port-service-mapping.csv`、`error-codes.json`
- evals 里的文件：按测试场景命名，如 `normal-case.md`、`edge-case-missing-data.md`

## 最少需要创建的文件

任何情况下都必须创建：`[skill名称]/SKILL.md`

其余文件夹和文件按需创建，没有内容就不建。