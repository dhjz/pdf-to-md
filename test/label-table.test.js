import { test } from 'node:test';
import assert from 'node:assert/strict';
import { borderlessLabelTables } from '../src/tables.js';

function item(str, x, y, width) {
  return { str, width, transform: [1, 0, 0, 1, x, y], height: 11 };
}
function row(y, cells) {
  let x = 61;
  return cells.map(([s, w]) => { const it = item(s, x, y, w); x += w + 40; return it; });
}

test('检测中文概念表：等距两列、短标签、文字内容', () => {
  const items = [];
  const rows = [
    ['概念', '含义'],
    ['智能客服', 'AI 自动接待、辅助人工的完整体系'],
    ['IVR', '电话接入后的自动语音导航和交互'],
    ['ESL', 'FreeSWITCH 的事件与控制接口'],
    ['ACD', '自动呼叫分配，决定电话给哪个坐席'],
    ['CTI', '电话与计算机业务系统联动'],
  ];
  rows.forEach((cells, i) => items.push(...row(480 - i * 24, cells.map((s, k) => [s, 40]))));
  const tables = borderlessLabelTables(items);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rows.length, rows.length);
  assert.deepEqual(tables[0].rows[0], ['概念', '含义']);
  assert.deepEqual(tables[0].rows[1], ['智能客服', 'AI 自动接待、辅助人工的完整体系']);
});

test('费率表（密集数字、无短表头）不误判为概念表', () => {
  const items = [];
  for (let r = 0; r < 8; r++) {
    const y = 480 - r * 24;
    items.push(item(String(18 + r), 61, y, 12));
    for (let c = 0; c < 8; c++) items.push(item((20 + c + r / 10).toFixed(2), 151 + c * 46, y, 30));
  }
  assert.equal(borderlessLabelTables(items).length, 0);
});

test('单次缩进的正文折行不被当成两列表', () => {
  const items = [
    item('注:半年交保险费=年交保险费*0.52，季交保险费=年交', 90, 421, 400),
    item('保险费*0.09。', 90, 405, 80),
    item('单位:人民币元', 90, 382, 90),
  ];
  assert.equal(borderlessLabelTables(items).length, 0);
});

test('规范章节的编号列表不被当成两列表', () => {
  const items = [
    item('①', 73.6, 772.2, 10), item('实施步骤', 87.6, 772.2, 45),
    item('1.', 79.8, 749, 12), item('设计系统对齐：按端导入对应组件库源文件并校验样式与间距', 91.2, 749, 400),
    item('2.', 79.8, 725, 12), item('接入 Figma 本地 MCP：IDE 中配置地址并启用 sse', 91.2, 725, 380),
    item('3.', 79.8, 701, 12), item('定义页面骨架：先固定布局方式再生成整体结构', 91.2, 701, 360),
    item('4.', 79.8, 677, 12), item('逐组件生成：每次显式指定项目封装组件', 91.2, 677, 350),
    item('5.', 79.8, 653, 12), item('审查组件复用与样式一致性并记录变更', 91.2, 653, 340),
  ];
  assert.equal(borderlessLabelTables(items).length, 0);
});

test('长句段落即便首列短标签也不被当成概念表', () => {
  const items = [];
  const rows = [
    ['概念', '含义'],
    ['智能客服', '这是一段很长的解释性文字，用来说明智能客服系统如何在真实业务场景里承接用户咨询并完成闭环'],
    ['IVR', '这是一段很长的解释性文字，用来说明电话接入后的语音导航和菜单交互是怎样一步步引导用户的'],
    ['ESL', '这是一段很长的解释性文字，用来说明事件与控制台接口如何配合并支撑状态同步的'],
    ['ACD', '这是一段很长的解释性文字，用来说明自动呼叫分配策略如何按照坐席技能与负载进行路由'],
  ];
  rows.forEach((cells, i) => items.push(...row(480 - i * 24, cells.map((s, k) => [s, 40]))));
  assert.equal(borderlessLabelTables(items).length, 0);
});
