# Insights module

`src/insights/index.ts` 提供只读的建筑流量汇总：`buildingFlow(world, buildingId, mode)` 返回按目的地排序的行，并区分 `demand`、`history`、`work` 三种视图。

- 当前意图（`demand`）分别统计尚未选方式的计划、已选择步行和已选择 Pod；意图不会冒充已完成行程。
- 实际出行（`history`）只读取该建筑出发、最近 1,800 模拟秒内的 `recentTrips`，区分步行与 Pod，最多对应 30 分钟窗口。
- 工作地点（`work`）按居民的 `homeId` 汇总其 `workId`，不受居民当前是否在家影响。

每行还带有居民 ID 列表与总数。UI 建筑检查器展示这些数字，流量图层用不同颜色/线型和地图标记呈现计划、步行、Pod 或工作关系；该模块不写入 World。
