import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'
import importPlugin from 'eslint-plugin-import'
import { defineConfig, globalIgnores } from 'eslint/config'

// 重构期策略:lint 只作用于「新结构」目录(app/features/shared)。
// 旧结构(components/hooks/lib/api/preview…)在逐片迁移中,迁完即删,暂不纳入 lint。
// 这样 baseline 立刻为绿,而所有迁入新结构的代码自动受铁律约束。
const NEW = [
  'src/app/**/*.{ts,tsx}',
  'src/features/**/*.{ts,tsx}',
  'src/shared/**/*.{ts,tsx}',
]

export default defineConfig([
  globalIgnores(['dist', 'node_modules', 'coverage']),

  // ── 基础规则(TS + React Hooks + Vite Refresh),仅新结构 ──────────────────
  {
    files: NEW,
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: { ecmaVersion: 2020, globals: globals.browser },
  },

  // ── 铁律一:单向依赖 app → features → shared,同层不互相 import ───────────
  {
    files: NEW,
    plugins: { boundaries },
    settings: {
      // 让 boundaries 能解析 `@/` 别名与无扩展名导入(读 tsconfig.app.json 的 paths)。
      'import/resolver': {
        typescript: { project: './tsconfig.app.json' },
      },
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app/**' },
        { type: 'feature', pattern: 'src/features/*/**', capture: ['feature'] },
        { type: 'shared', pattern: 'src/shared/**' },
      ],
    },
    rules: {
      // 不对「导入旧结构(未知元素)」报错——迁移期允许新片临时引用旧文件。
      'boundaries/no-unknown': 'off',
      'boundaries/no-unknown-files': 'off',
      // 铁律一(方向)+ 铁律三(feature 黑盒:外部只能进 index.ts)合并表达。
      // v6 已把 entry-point 并入 dependencies,用 `internalPath` 约束「进入目标元素的哪个文件」。
      'boundaries/dependencies': ['error', {
        default: 'disallow',
        rules: [
          // app:可用 app / shared 任意文件;用 feature **只能走其 index.ts**(铁律三)。
          { from: { type: 'app' }, allow: { to: { type: ['app', 'shared'] } } },
          { from: { type: 'app' }, allow: { to: { type: 'feature', internalPath: ['src/features/*/index.ts', 'src/features/*/index.tsx'] } } },
          // feature:可用 shared 任意 + 自己这一片任意内部文件;不得跨 feature。
          { from: { type: 'feature' }, allow: { to: { type: 'shared' } } },
          { from: { type: 'feature' }, allow: { to: { type: 'feature', captured: { feature: '{{from.captured.feature}}' } } } },
          // shared:只能用 shared。
          { from: { type: 'shared' }, allow: { to: { type: 'shared' } } },
        ],
      }],
    },
  },

  // ── 铁律(样式):禁内联 style、禁裸十六进制颜色 ──────────────────────────
  {
    files: NEW,
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "JSXAttribute[name.name='style']",
          message: '禁内联 style:用 Tailwind 工具类 / design tokens(见架构文档 §3.1)。',
        },
        {
          selector: "Literal[value=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
          message: '禁裸十六进制颜色:统一走 design tokens(@theme),见架构文档 §3.1。',
        },
      ],
    },
  },

  // ── 铁律三(第二道闸,barrel):app/shared 引用 feature 只能到 `@/features/X`(其 index),
  //    不得绕进 `@/features/X/任何内部文件`。与 boundaries internalPath 互为冗余,更标准、不脆。
  //    (feature 之间已被 boundaries 完全禁止互相 import,故无需在 features/ 内再设此规则;
  //     feature 内部相对路径导入 `./sub/x` 不受影响——本规则只盯 `@/features/*/*` 形态。)
  {
    files: ['src/app/**/*.{ts,tsx}', 'src/shared/**/*.{ts,tsx}'],
    plugins: { import: importPlugin },
    rules: {
      'import/no-internal-modules': ['error', {
        forbid: ['@/features/*/*', '@/features/*/*/**'],
      }],
    },
  },

  // ── 铁律(数据):组件不得直连 useQuery/useMutation;封进本 feature 的 api/ ─
  {
    files: ['src/features/**/*.{ts,tsx}'],
    ignores: ['src/features/*/api/**', 'src/features/*/hooks/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: '@tanstack/react-query',
          importNames: ['useQuery', 'useMutation'],
          message: '组件不要直连 useQuery/useMutation:封进本 feature 的 api/ 数据 hook(见架构文档 §3.2)。',
        }],
      }],
    },
  },
])
