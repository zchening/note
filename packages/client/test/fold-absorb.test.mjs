/**
 * 折叠分组「吸收」判据（FOLD-ABS 系列）—— 用户报障第 6 条
 *
 * 🔴🔴🔴 本文件的判据全部来自**真浏览器实测老项目**，不是读 applyFolds 源码推的。
 *   探针：Playwright 打开 `notesync/index.html`，日间主题，逐字符以固定节奏敲键盘，
 *   然后读 `#editor` 直接子块的 className。四个场景的实测结果：
 *
 *   A「标记独占一行」 [折叠] / 内容一 / 内容二 / (空)
 *       → [ns-fold ns-fold-collapsed] "[折叠]"
 *         [ns-fold-body ns-fold-hide] "内容一"
 *         [ns-fold-body ns-fold-hide] "内容二[/折叠]"   ← 锚被补在组内最后一行行尾
 *         [(none)] ""
 *   B「标记+标题同行」 [折叠]买菜清单 / 内容一 / 内容二 / (空)
 *       → 与A 同构，只是把手标题是"买菜清单"
 *   C「只有一行正文」 [折叠]买菜清单 / 内容一 / (空)
 *       → [ns-fold-body ns-fold-hide] "内容一[/折叠]"
 *   D「正文后有**空行**再接组外」 [折叠] / 内容一 / (空) / 组外
 *       → [ns-fold-body ns-fold-hide] "内容一[/折叠]"   ← 锚补在组内最后一行行尾
 *         [(none)] ""          ← 空行**不入组**（v10.1.2 seedFoldGroup 的 isBlankFoldLine 闸）
 *         [(none)] "组外"
 *
 *   ⇒ 吸收边界的三条权威规则（**老项目 v10.1.2 口径**，index.html:4382-4388
 *     「v10.1.2（用户拍板）：建组那一刻按『空行切』定界，并立刻落一枚闭合锚把边界冻住」）：
 *     R1 从把手的**下一块**开始吸，不是从把手本身
 *     R2 遇**第一个空行**停（空行不入组）—— 只在**建组那一帧**判，
 *        之后组内可以自由打空行（边界已被锚冻结，不再重算）
 *     R3 遇**下一个把手**停；无空行则一路收到文末
 *     R4 手打的独立行 `[/折叠]` 是"组尾锚"，锚行本身**不进正文**（S3 实测：
 *        它被标成 ns-fold-endline 压 0 高，组内在它之前）
 *
 * 🔴🔴 **老项目源码里 v10.0.3 与 v10.1.2 两套空行规则并存，只读源码一定会判错**：
 *   `index.html:4034-4040`（v10.0.3）逐字写「空行彻底退出边界判定 → 标题以下全归组」，
 *   且 `applyFolds:4289-4298` 的定界循环确实只有两个 break（空行走 `:4307`
 *   被标 `ns-fold-gap` 仍在组内）。看起来 v10.1.2 是遗留路径 —— **错**。
 *   v10.1.2 版本号更大、注释明写「（用户拍板）」，由 `applyFolds:4286` 在
 *   `seedArmed && 本帧新增把手` 时调 `seedFoldGroup:4399-4404`，**保留
 *   `isBlankFoldLine` break 并立刻补锚把边界冻住**。
 *   ⇒ 现行口径 = v10.1.2。v10.0.3 那段是被**收紧过**、不是被删掉。
 *   Agent 在这条上栽过两次**方向相反**的错（先照抄 v10.1.2 又反向"纠错"删掉 break），
 *   两次都是只读源码就下结论。**版本号更大的那次拍板才是现行口径。**
 *
 * 🔴 探针自身的坑（写下来防止下一个人重踩）：
 *   reset 必须用 `innerHTML='<div><br></div>'`，**不能**用 `''`。
 *   空 contenteditable 里直接打字，Chromium 可能只生成裸文本节点（无 div 壳），
 *   而 applyFolds 迭代的是 `editor.children`（只含元素）⇒ 裸文本节点对它完全不可见
 *   ⇒ 探针会误报"把手块凭空消失、根本没折叠"。这是**探针的假数据**，不是老项目行为。
 *   我第一版就踩了，S2/S4 双双误报"老项目不认标记+标题同行"，差点据此改错方向。
 *
 * 判据纪律：所有断言 import 生产代码（behaviors.ts 的 $promoteFoldMarks 注册入口），
 *   不把实现抄进测试；每条「应该有」配一条「不应该有」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $createRangeSelection,
  $setSelection,
  $createPoint,
} from 'lexical';

import { registerBehaviors, promoteFoldMarksNow } from '../src/behaviors.ts';
import { ALL_NODES } from '../src/node-registry.ts';
import { $isFoldNode } from '../src/nodes.ts';

// 🔴🔴 必须垫一个 window：`$promoteFoldMarks` 第一行就读
//   `(window as ...).__FOLD_DBG__`。Node 里没有 window ⇒ ReferenceError，
//   而 Lexical 的 update 会把回调异常交给 `_onError` **吞掉**（不抛、不生效），
//   症状是"建组函数被调用了但什么都没发生"—— 静默降级的教科书案例。
//   补上 window 之后本文件才真的在测生产逻辑。
globalThis.window = globalThis;

/**
 * 造一个 headless 编辑器并灌入若干段（每段一串纯文本）。
 * headless（不挂 rootElement）能完整走 update/read，纯节点操作不需要 DOM。
 * 🔴 `nodes` 必须给**全量** ALL_NODES：少一个（如 ListItemNode）会在
 *   registerBehaviors 里抛 "has not been registered"，症状与被测功能无关。
 */
function buildEditor(paras) {
  const editor = createEditor({ nodes: ALL_NODES, namespace: 'fold-abs-test' });
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (const t of paras) {
        const p = $createParagraphNode();
        p.append($createTextNode(t));
        root.append(p);
      }
    },
    { discrete: true },
  );
  return editor;
}

/**
 * 把光标放到第 idx 段的**末尾**，模拟"用户刚打完这一行标记"。
 * `$promoteFoldMarks` 的入口判据是段首 TextNode + collapsed range selection，
 * 所以落点必须在文本节点上（element point 会被`$isTextNode(anchor)` 挡掉）。
 */
function caretAtEndOfPara(editor, idx) {
  editor.update(
    () => {
      const root = $getRoot();
      const p = root.getChildren()[idx];
      const last = p.getLastDescendant();
      const point = $createPoint(last.getKey(), last.getTextContentSize(), 'text');
      const sel = $createRangeSelection();
      sel.anchor = point;
      sel.focus = point;
      $setSelection(sel);
    },
    { discrete: true },
  );
}

/**
 * 触发自动建组：走**生产代码本体**（`promoteFoldMarksNow` 就是 setTimeout 里那个包装）。
 * 🔴 判据不许自己造钩子：钩子缺失导致的红是**假红**，证明不了任何事。
 */
function runPromote(editor) {
  promoteFoldMarksNow(editor);
}

/** 注册生产 behaviors（会挂上 update listener），返回句柄。 */
function register(editor) {
  return registerBehaviors(editor, {
    onDiag: () => {},
    onHint: () => {},
  });
}

/** 读出当前根下每块的类型与文本（折叠块读成`fold:标题|子块…`）。 */
function dump(editor) {
  let out = [];
  editor.getEditorState().read(() => {
    out = $getRoot()
      .getChildren()
      .map((n) => {
        if ($isFoldNode(n)) {
          const title = n.title.map((s) => s.t).join('');
          // 🔴 FoldNode 的**第一个子节点就是标题段**（nodes.ts 的设计，
          //   标题不进 children 字段而是字段，但 DOM 上是首子节点）。
          //   所以判"正文"必须**跳过首个子节点**，否则会把标题当成正文第一行。
          const kids = n
            .getChildren()
            .slice(1)
            .map((c) => (c.getTextContent ? c.getTextContent() : '?'));
          return { type: 'fold', title, kids };
        }
        return { type: 'para', text: n.getTextContent() };
      });
  });
  return out;
}

/* ============ R1/R2/R3：吸收边界 ============ */

test('FOLD-ABS-01 把手以下、到边界为止，全部进同一个 fold', () => {
  const editor = buildEditor(['[折叠]', '内容一', '内容二']);
  register(editor);
  caretAtEndOfPara(editor, 0);
  runPromote(editor);

  const d = dump(editor);
  assert.equal(d.length, 1, '三段应合成一个块，实际=' + JSON.stringify(d));
  assert.equal(d[0].type, 'fold', '第一个块应是 fold');
  // 老项目实测：正文两行都进组
  assert.deepEqual(
    d[0].kids.map((t) => t.replace(/\[\/折叠\]$/, '')),
    ['内容一', '内容二'],
    '正文两行都应进组（末尾可能被补锚，逐字比时剥掉）',
  );
});

test('FOLD-ABS-02 🔴 空行截断吸收（老项目 v10.1.2 seedFoldGroup 的 isBlankFoldLine 闸）', () => {
  // 老项目 D 场景实测：[折叠] / 内容一 / (空) / 组外
  //   → 组内只有"内容一"，空行与"组外"都在组外
  const editor = buildEditor(['[折叠]', '内容一', '', '组外']);
  register(editor);
  caretAtEndOfPara(editor, 0);
  runPromote(editor);

  const d = dump(editor);
  const foldIdx = d.findIndex((b) => b.type === 'fold');
  assert.ok(foldIdx >= 0, '应生成 fold，实际=' + JSON.stringify(d));
  assert.deepEqual(
    d[foldIdx].kids.map((t) => t.replace(/\[\/折叠\]$/, '')),
    ['内容一'],
    '空行必须截断吸收：老项目 v10.1.2 实测组内只有"内容一"',
  );
  // 反向：组外的段落必须还留在根上，且在 fold 之后
  const after = d.slice(foldIdx + 1).map((b) => b.text ?? '');
  assert.ok(
    after.includes('组外'),
    '"组外"必须留在根上（没被吸进组），实际=' + JSON.stringify(d),
  );
  assert.ok(
    !d[foldIdx].kids.some((t) => t.includes('组外')),
    '"组外"绝不能被吸进组（会吞掉用户内容）',
  );
});

test('FOLD-ABS-03 🔴 下一个把手截断吸收（两组不串味）', () => {
  // 老项目 S4 实测：组一的正文不能吃掉组二的把手
  const editor = buildEditor(['[折叠]组一', '甲', '[折叠]组二', '丙']);
  register(editor);
  caretAtEndOfPara(editor, 0);
  runPromote(editor);

  const d = dump(editor);
  const folds = d.filter((b) => b.type === 'fold');
  assert.equal(folds.length, 1, '本帧只该建一个组（组二尚未触发），实际=' + JSON.stringify(d));
  assert.deepEqual(
    folds[0].kids.map((t) => t.replace(/\[\/折叠\]$/, '')),
    ['甲'],
    '组一只该吃到"甲"，下一个把手必须截断',
  );
  // 反向：组二的标记绝不能被组一吞掉
  assert.ok(
    !folds[0].kids.some((t) => t.includes('[折叠]')),
    '组一不能吞掉组二的把手标记（那是内容损坏）',
  );
});

test('FOLD-ABS-04 🔴 手打的独立行 [/折叠] 是组尾锚，锚行不进正文', () => {
  // 老项目 S3 实测：[/折叠] 独立成行时被标 ns-fold-endline（压 0 高），
  // 它的**前面**那些行才是正文。
  const editor = buildEditor(['[折叠]买菜清单', '1、橙子', '2、苹果', '[/折叠]']);
  register(editor);
  caretAtEndOfPara(editor, 0);
  runPromote(editor);

  const d = dump(editor);
  const fold = d.find((b) => b.type === 'fold');
  assert.ok(fold, '应生成 fold，实际=' + JSON.stringify(d));
  assert.deepEqual(
    fold.kids.map((t) => t.replace(/\[\/折叠\]$/, '')),
    ['1、橙子', '2、苹果'],
    '锚行之前的都是正文',
  );
  // 反向：锚标记本身不该作为可见正文留在组内
  assert.ok(
    !fold.kids.some((t) => t.trim() === '[/折叠]'),
    '独立锚行不该原样留在正文里（老项目把它压 0 高/不可见）',
  );
});