# `ported/` — verbatim mirror of NID renderer code

The files in this directory are 1:1 ports of selected functions and data
tables from `D:\20_code\NetworkIntegrationDesign\src\webview\pptxViewerPanel.ts`.

**Do not "refactor" or "improve" the code here.** The whole point of this
directory is that every line was forged by real-world PPT corner cases NID
hit before us. Refactoring breaks the alignment story — debug fidelity
issues by diffing against the same function in NID's source.

When porting:

- Drop `vscode` / webview imports.
- Use the local `escapeHtml` defined in `shapeBuilder.ts` instead of NID's
  `htmlUtils.ts` import.
- `export` whatever the wrapper (`slideToHtml.ts`) needs to call.
- Preserve all comments — they document the corner cases.

| File | Mirrors NID lines | Function/Table |
|------|-------------------|----------------|
| `presetGeomPaths.ts` | 2320–2395 | `_presetGeomPaths: Record<string, string>` |
| `shapeBuilder.ts`    | 2396–2842 (+helpers) | `_buildShapeParts` + `_formatAutoNum` + `_toRoman` + `_toAlpha` + small helpers |
