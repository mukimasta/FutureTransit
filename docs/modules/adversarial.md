# 对抗验收：真实接送、有限泊位与改造安全

本轮只新增 `tests/adversarial.test.ts` 与本说明，不修改实现。验收不是复述调度日历：测试从 Pod 的 `segments`、发车前起点、结束后无限期终点承诺和空闲 `berthId` 独立重建物理占用，再检查不同 Pod 是否在边、节点、交叉点或泊位上重叠。

## 覆盖结果

共 14 项：

- 正向 9 项：对向单区间互斥、有限日历之外的终点尾承诺、两平台一停车恢复接送、在途拆轨排空后执行、在途移泊位排空后执行、取消待改造、容量失败原子性、合法延迟发车存读、在途保存后身份/位置/未来轨迹一致。
- 修复前失败 5 项：下列伪造输入被实现接受，而测试要求拒绝。它们均保留为普通回归测试，未用 `skip` 或 expected-failure 隐藏。

## 可复现缺陷

1. **计划可无预约发布。** 先调用 `planRelocation` 得到合法轨迹，把 `plan.reservations` 改成空数组，再调用 `commitPlan`；提交成功且 Pod 进入运行态。验收时 `src/scheduler/index.ts:617-663` 只检查现有预约的 owner/区间/冲突，没有从轨迹反查预约完备性。这会让真实移动绕过单区间互斥。
2. **必填 Journey 字段可缺失。** 从合法步行存档删除 `journey.purpose`，`parseWorld` 仍接受。验收时 `src/persistence/index.ts:89` 校验 mode/stage，却未校验 purpose。
3. **ID 高水位可回退。** 把合法存档的 `nextId` 改成现有 `berth-N` 的 `N`，`parseWorld` 仍接受；下一次同前缀创建会生成重复 ID。验收时 `src/persistence/index.ts:30,35` 只检查 `nextId >= 1` 和各数组内部当前去重，没有验证生成器高水位。
4. **Pod 轨迹可超速。** 保持相邻网格、连续时间和完整预约，把一段 20 米 loaded move 压缩到 0.001 秒，存档仍被接受。验收时 `src/persistence/index.ts:63-69` 只校验相邻性、连续性与资源键，没有按 `CELL_METERS / POD_METERS_PER_SECOND` 校验移动时长，也未校验节点/上下客时长。
5. **居民与 Pod 不是双向唯一关系。** 两个合法 relocation plan 改为同时 `residentId` 指向同一个仍在室内的居民，并补齐形式合法的上下客时间，存档仍被接受。验收时 `src/persistence/index.ts:58,74,84-93` 只在居民状态为 boarding/riding/alighting 时检查“居民 → Pod”，没有检查“Pod → 居民”、同一居民最多一辆车，以及运行计划与居民 Journey 的一致性。

## 运行

```bash
npx vitest run tests/adversarial.test.ts
```

修复前结果是 9 passed / 5 failed。修复后已复核：本文件 14/14 通过；完整测试 51/51 通过；`npm run typecheck` 通过。额外的合法延迟发车存读用例确认严格轨迹校验不会误伤等待既有交通资源的未来计划。
