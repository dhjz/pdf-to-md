import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render2 } from '../src/render2.js';

function line(str, x, y) {
  return {
    y, x, right: x + str.length * 8, height: 11, fontSize: 11, dropped: false,
    text: str, items: [{ str, transform: [1, 0, 0, 1, x, y], width: str.length * 8 }],
  };
}

test('带句号的编号流程项不做标题，按有序列表逐行输出', () => {
  const lines = [
    line('1. 用户拨打客服电话。', 62, 740),
    line('2. PSTN/SIP 接入 FreeSWITCH。', 62, 720),
    line('3. FreeSWITCH 触发 ESL 事件。', 62, 700),
  ];
  const md = render2([{ pageNumber: 1, lines, tables: [], images: [] }]);
  assert.doesNotMatch(md, /^## /m);
  assert.match(md, /1\. 用户拨打客服电话。/);
  assert.match(md, /2\. PSTN\/SIP 接入 FreeSWITCH。/);
  assert.match(md, /3\. FreeSWITCH 触发 ESL 事件。/);
});

test('无句号的编号小节标题仍渲染为标题', () => {
  const lines = [line('4. 转人工坐席', 56, 740), line('正文内容。', 56, 700)];
  const md = render2([{ pageNumber: 1, lines, tables: [], images: [] }]);
  assert.match(md, /^## 4\. 转人工坐席$/m);
});

test('缩进短行组成的列表渲染为 bullet，引用行不误判', () => {
  const lines = [
    line('典型能力包括:', 56, 740),
    line('ASR:语音识别', 74, 710),
    line('TTS:语音合成', 74, 690),
    line('NLU:意图识别', 74, 670),
  ];
  const md = render2([{ pageNumber: 1, lines, tables: [], images: [] }]);
  assert.match(md, /- ASR:语音识别/);
  assert.match(md, /- TTS:语音合成/);
  assert.match(md, /- NLU:意图识别/);
});

test('英文与中文折行处保留空格', () => {
  const lines = [
    line('FreeSWITCH 是软交换引擎。ESL 允许外部程序通过 TCP Socket 连接', 56, 740),
    line('FreeSWITCH，实现:监听事件', 56, 720),
  ];
  const md = render2([{ pageNumber: 1, lines, tables: [], images: [] }]);
  assert.match(md, /连接 FreeSWITCH/);
});

test('无编号但字号与已有标题一致的行也识别为标题', () => {
  const big = (str, y) => ({ ...line(str, 56, y), height: 15.4, fontSize: 15.4 });
  const lines = [
    big('1. 智能客服', 740),
    big('2. IVR', 720),
    line('正文内容。', 56, 710),
    big('典型智能客服通话流程', 680),
    line('1. 用户拨打客服电话。', 56, 650),
    big('简单总结', 620),
    line('结尾。', 56, 590),
  ];
  const md = render2([{ pageNumber: 1, lines, tables: [], images: [] }]);
  assert.match(md, /^## 典型智能客服通话流程$/m);
  assert.match(md, /^## 简单总结$/m);
});

test('大字号但属于正文段落的行不被误判为标题', () => {
  // Body-size wrapped line must not be promoted just because a long paragraph
  // happens to end without terminal punctuation on a physical line.
  const lines = [
    { ...line('1. 智能客服', 56, 740), height: 15.4, fontSize: 15.4 },
    line('面向用户，基于账户查询、资金流水、盈亏分析等基础服务引入', 56, 700),
    line('AI 服务，通过自然语言与多智能体协作的方式', 56, 680),
    line('成，同时提供个股诊断能力。', 56, 660),
  ];
  const md = render2([{ pageNumber: 1, lines, tables: [], images: [] }]);
  assert.doesNotMatch(md, /^## 面向用户/m);
  assert.doesNotMatch(md, /^## 成，同时/m);
});

test('编号列表项的折行并入同一项，不再拆成独立段落', () => {
  // test.pdf "3.2 系统集成范围": each numbered item wraps onto a second
  // physical baseline. The wrapped tail belongs to the SAME list item — it
  // must be joined back, not emitted as a separate prose paragraph (which
  // the viewer renders as a second <p> outside the <li>).
  const lines = [
    line('1. 盯盘、账户两个智能体按智能体注册协议接入甲方 AI 总控平台，配合完成身份链路、', 111, 621),
    line('会话管理、记忆策略、安全围栏、评测、观测对接；', 90, 600),
    line('2. 与甲方及甲方客户系统及接口的联调对接，包括行情中心、账户中心、资金中心、柜台', 111, 570),
    line('交易系统、盯盘系统、板块字典、研报库、skill 等（根据落地的业务场景确认对接范围）。', 90, 549),
  ];
  const md = render2([{ pageNumber: 1, lines, tables: [], images: [] }]);
  assert.match(md, /1\. 盯盘、账户两个智能体按智能体注册协议接入甲方 AI 总控平台，配合完成身份链路、会话管理、记忆策略、安全围栏、评测、观测对接；/,
    '折行应并入编号列表项，中间不插入空格');
  assert.match(md, /2\. 与甲方及甲方客户系统及接口的联调对接，包括行情中心、账户中心、资金中心、柜台交易系统/,
    '第二项的折行也应并入同一项');
  assert.doesNotMatch(md, /\n\n会话管理、/, '折行不得独占一个段落');
  assert.doesNotMatch(md, /\n\n交易系统、盯盘系统/, '折行不得独占一个段落');
});

test('相邻编号列表项：前项未以句末标点结束时也各自独立成项', () => {
  const lines = [
    line('1. 第一项没有句末标点', 111, 621),
    line('2. 第二项也没有句末标点', 111, 590),
  ];
  const md = render2([{ pageNumber: 1, lines, tables: [], images: [] }]);
  assert.match(md, /1\. 第一项没有句末标点/);
  assert.match(md, /2\. 第二项也没有句末标点/);
  assert.doesNotMatch(md, /第一项没有句末标点2\./, '两个列表项不得粘连');
});
