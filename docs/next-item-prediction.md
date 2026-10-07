# “预测下一项”调研与改进

调研日期：2026-10-07。适用位置：共享章节库、完成预测中的章节编辑器、整册复盘，以及任务录入中的下一项建议。

## 结论

这个功能适合采用“根据相邻示例延续命名规则”的方式：先识别编号、范围或日期，再用已有名称确定变化位置和步长，展示具体结果与依据，由用户点击添加。

编号规律与章节内容是两种不同的问题。仅凭“第一章 函数、第二章 导数”不能知道第三章的教学内容；预测器只应延续编号，让用户填写标题。这里的建议来自下面的产品文档和研究，而不是对 Excel 内部算法的推测。

## 参考产品如何处理

| 产品或研究 | 官方资料能确认的行为 | 对当前功能的启发 |
| --- | --- | --- |
| Excel Auto Fill | 用源单元格建立序列；例如输入 1、2 或 2、4；填充后可以选择 Auto Fill Options。 | 不能永远加 1；步长要从相邻样本取得。 |
| Excel Flash Fill | 根据用户示例识别字符串转换，显示其余结果的预览，由用户接受。 | 显示结果与依据；编号延续与字符串内容转换应区分。 |
| Google Sheets AutoFill | 至少输入两个相邻单元格；数字、日期序列会延续，其他列表可以重复；建议可以预览并接受。 | 分析有序样本；不要把任意文字都解释成编号。当前章节清单要求名称唯一，因此不能直接照搬重复列表。 |
| Google Sheets Smart Fill | 识别模式并给出建议；可以查看结果所用公式。 | 预测依据应可检查，例如“末尾 3 个名称，步长 +2”。 |
| LibreOffice Calc | 支持自动识别算术序列，也提供方向、步长、起止值、日期单位等显式设置。 | 自动规则无法确定时，长期可提供手动规则和步长设置。 |
| Handsontable | 提供拖动填充、范围预览，以及填充前后调整和校验的钩子。 | 生成候选与实际追加应分别处理；点击时重新计算，防止使用过期结果。它的填充 UI 不代表能理解任意中文章节名称。 |
| Microsoft Research 的示例驱动字符串合成研究 | 从输入输出示例合成规则，排序多个解，并在存在多种解释时请求更多示例。 | 有歧义时说明问题并要求更多样本，避免给出虚假的确定性。 |

资料链接：

- [Excel：Fill data automatically in worksheet cells](https://support.microsoft.com/en-us/excel/get-started/fill-data-automatically-in-worksheet-cells)
- [Excel：Using Flash Fill in Excel](https://support.microsoft.com/en-us/excel/using-flash-fill-in-excel)
- [Google Sheets：Automatically create a series or list](https://support.google.com/docs/answer/75509?hl=en)
- [Google Sheets：Use Smart Fill in Sheets to automate data entry](https://support.google.com/docs/answer/9914525?hl=en)
- [LibreOffice Calc：Automatically Filling in Data Based on Adjacent Cells](https://help.libreoffice.org/latest/en-US/text/scalc/guide/calc_series.html)
- [LibreOffice Calc：Fill Series](https://help.libreoffice.org/latest/en-GB/text/scalc/01/02140600.html?DbPAR=CALC)
- [Handsontable：Autofill values](https://handsontable.com/docs/javascript-data-grid/autofill-values/)
- [Microsoft Research：Automating String Processing in Spreadsheets using Input-Output Examples](https://www.microsoft.com/en-us/research/publication/automating-string-processing-spreadsheets-using-input-output-examples/)

## 原实现中已复现的问题

原来的 inferNextNamedItemName 取最后一个名称中最后一组阿拉伯或中文数字，逐次加 1，遇到重名就继续加。前面的名称只用于检查重名，不用于识别规律。

| 输入 | 原结果 | 改进后的结果 |
| --- | --- | --- |
| 第1章、第3章 | 第4章 | 第5章 |
| 1.1、1.3 | 1.4 | 1.5 |
| 1.1、2.1、3.1 | 3.2 | 4.1 |
| P20-35 | P20-36 | P36-51；明确提示这是单样本、连续等长范围的推测 |
| 第三章 三角函数 | 第三章 四角函数 | 第四章；提示标题自行填写 |
| 2026-10-31 | 2026-10-32 | 2026-11-01 |
| 1、2、4 | 5 | 暂停预测，提示相邻步长不一致 |

章节列表重排后，原按钮还可能保留旧预测；现在移动章节后立即更新。

## 本次已经实现的规则

1. 三个入口使用同一套序列预测。章节库与整册复盘展示一个待添加名称和两个后续预览；任务录入仍优先建议清单中已有的未完成章节，新增名称建议使用同一算法并显示依据。
2. 从末尾连续、结构相同的名称确定规律。两个样本可以建立非零固定步长，更多样本用于一致性检查。可以确定任意一个变化位置，例如 1.1、2.1、3.1 中变化的是第一段。
3. 单个样本只使用可解释的默认规则：普通编号 +1、点分层级编号的末级 +1、明确的页码或题号范围整段向后平移、完整日期下一天。提示中明确写出“仅 1 个样本”，不显示未经校准的准确率。
4. 保留阿拉伯数字前导零、全角数字，以及中文按位编号的风格；处理中文计数进位，拒绝非法或超出安全整数范围的编号。
5. 第 N 章等名称附带标题时，只延续编号，不复用章节标题。普通文字里的“三”“一”“二”不直接作为可递增编号。
6. 日期按 UTC 的日历日计算，处理跨月、跨年与闰日；多个完整日期可以建立固定天数的间隔。
7. 支持单个英文字母和附录 A 等字母编号，在 A–Z 或 a–z 范围内按样本步长延续。
8. 归档名称用于防止重名，不用于学习活动序列的步长；按已识别步长跳过重名。若中间缺项确实对应已存在的名称，连续点击仍保持原步长。
9. 多个普通编号同时变化、步长冲突、范围长度变化、无明确上下文的单个 20-35 等情况暂停预测，给出具体原因。
10. 输入、重排、归档、恢复、追加之后重新计算；点击时也重新计算，追加的仍是可编辑草稿。

## 当前边界与后续优先级

- 当前规则是固定整数步长、等长范围、固定天数日期及单字母序列。尚未实现每月、工作日、倍增、任意文字循环和 A→…→Z→AA 等规则。
- 1.9 的下一项默认是 1.10。没有父章节的长度信息，不能自行判断应该跳到 2.1。
- 只有一个范围时，P20-35→P36-51 是连续等长的默认假设，不意味着实际书本每章有 16 页。
- 当前会检查整段末尾同结构序列。出现未解释的跳号后，需要修正已有名称或手动添加；尚未提供“从此处重新开始识别”的选择。
- 暂未根据自然语言生成未知章节标题。若以后要做，应引入用户提供的目录等可核对来源，再考虑内容补全。

后续建议按以下顺序实施；以下项目尚未包含在本次代码中：

1. 增加折叠的“填充规则”：自动、编号、范围、日期，以及自定义步长、要改变的编号位置和识别起点。普通情况下仍保持一键添加。
2. 需要批量录入时，再增加数量与结束值设置；先展示待添加名称，校验重名和边界后一次添加，支持撤销这批新增。
3. 在用户确实需要的情况下增加月份、工作日、自定义目录顺序等规则；每种规则单独验证，不把它们混成一个泛化字符串猜测器。

## 验证方式

无需新增依赖：

```sh
node --check app.js
node --test tests/named-item-prediction.test.cjs
git diff --check
```

回归测试加载完整 app.js，但不启动应用或访问用户数据。覆盖原误判、格式保留、冲突拒绝、重名跳过、连续点击，以及章节编辑器、整册复盘、任务录入的实际函数调用。DOM 使用测试替身，不能代替真实浏览器中的视觉、焦点与响应式验收。
