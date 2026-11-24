import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCodeLanguage } from '../src/code-lang.js';

// Issue #34: label fenced code blocks with a language when the whole block is
// ASCII code/symbols, or Chinese only appears inside that language's comments.
// Prose with bare Chinese stays `txt`. One case per requested language.

const cases = [
  ['javascript', ['function f(x) {', '  return x + 1;', '}']],
  ['typescript', ['interface User {', '  name: string;', '}']],
  ['html', ['<div class="box">', '  <span>hi</span>', '</div>']],
  ['css', ['.box {', '  color: red;', '}']],
  ['python', ['def f(x):', '    return x + 1']],
  ['java', ['public class A {', '  public static void main(String[] args) {}', '}']],
  ['c', ['#include <stdio.h>', 'int main(void) { return 0; }']],
  ['cpp', ['#include <iostream>', 'std::cout << "hi";']],
  ['csharp', ['using System;', 'Console.WriteLine("hi");']],
  ['go', ['func f() {', '  x := 1', '}']],
  ['rust', ['fn main() {', '  let x = 1;', '}']],
  ['json', ['{', '  "a": 1', '}']],
  ['yaml', ['name: app', 'port: 8080', 'debug: true']],
  ['ini', ['[server]', 'host = localhost', 'port = 8080']],
  ['sql', ['SELECT id FROM users WHERE id = 1;']],
  ['bash', ['#!/bin/bash', 'echo hi']],
  ['shell', ['#!/bin/sh', 'echo hi']],
  ['bat', ['@echo off', 'set X=1']],
];

for (const [lang, lines] of cases) {
  test(`识别为 ${lang}`, () => {
    assert.equal(detectCodeLanguage(lines), lang);
  });
}

test('中文出现在语言注释里仍识别为对应语言', () => {
  assert.equal(detectCodeLanguage([
    'func demo() {', '  // 中文注释说明', '  x := 1', '}',
  ]), 'go');
  assert.equal(detectCodeLanguage([
    '# 中文注释', 'def f():', '    return 1',
  ]), 'python');
  assert.equal(detectCodeLanguage([
    '/* 中文块注释 */', 'function f() { return 1; }',
  ]), 'javascript');
  assert.equal(detectCodeLanguage([
    '<!-- 中文注释 -->', '<p>hi</p>',
  ]), 'html');
});

test('Rust 生命周期中的单引号不吞掉行尾中文注释', () => {
  assert.equal(detectCodeLanguage([
    "fn foo<'a>(x: &'a str) -> &'a str { // 中文注释",
    '    x',
    '}',
  ]), 'rust');
});

test('中文出现在代码外（非注释）时保持 txt，不误标语言', () => {
  const prose = [
    '@product-prd 请基于功能清单撰写PRD内容，严格遵循规范。',
    '请根据 docs/接口文档.md 生成测试用例。',
  ];
  assert.equal(detectCodeLanguage(prose), '');
  assert.equal(detectCodeLanguage(['a := User{1, "A"}', 'a[0] 会被改成 100 。']), '');
});

test('无代码信号的普通文本与单行配置保持 txt', () => {
  assert.equal(detectCodeLanguage(['first line', 'second line']), '');
  assert.equal(detectCodeLanguage(['result = 1']), '');
  assert.equal(detectCodeLanguage([]), '');
});

// Issue #34: Chinese inside string literals ('...', "...", `...`) is code too.
test('引号/反引号内的中文算代码，仍识别为对应语言', () => {
  // 双引号
  assert.equal(detectCodeLanguage([
    'const msg = "你好，世界";',
    'console.log(msg);',
  ]), 'javascript');
  // 单引号
  assert.equal(detectCodeLanguage([
    'func f() {',
    "  x := '中文字符串'",
    '  return x',
    '}',
  ]), 'go');
  // 反引号模板字符串
  assert.equal(detectCodeLanguage([
    'function f(name) {',
    '  return `你好，${name}`;',
    '}',
  ]), 'javascript');
  // JSON 字符串值里的中文
  assert.equal(detectCodeLanguage([
    '{',
    '  "name": "中文名称",',
    '  "ok": true',
    '}',
  ]), 'json');
  // Python 单/双引号
  assert.equal(detectCodeLanguage([
    "def f():",
    "    a = '中文'",
    '    print(a)',
  ]), 'python');
});

test('引号内的转义引号不破坏字符串边界，中文仍算代码', () => {
  assert.equal(detectCodeLanguage([
    'const s = "he said \\"你好\\" today";',
    'console.log(s);',
  ]), 'javascript');
});

test('引号外的裸中文仍然是正文，不误标语言', () => {
  assert.equal(detectCodeLanguage([
    'const a = 1; 这是一段中文说明',
    'console.log(a);',
  ]), '');
  // 未闭合的单引号（如英文 it's）不能把后面的裸中文当成字符串吞掉
  assert.equal(detectCodeLanguage([
    "it's 一段中文说明",
    'console.log(b);',
  ]), '');
  assert.equal(detectCodeLanguage([
    "const b = '开引号后有中文",
    'console.log(b);',
  ]), '');
});

test('泛型尖括号、JS 关键字与字符串内 // 不应误判语言', () => {
  assert.equal(detectCodeLanguage([
    'function f(items: Array<string>): void {',
    '  console.log(items.length);',
    '}',
  ]), 'javascript');
  assert.equal(detectCodeLanguage(['fn f(v: Vec<u8>) {', '  println!("{}", v.len());', '}']), 'rust');
  assert.equal(detectCodeLanguage(['vector<int> v;', 'v.push_back(1);']), 'cpp');
  assert.equal(detectCodeLanguage(['class User {', '  greet() { console.log("hi"); }', '}']), 'javascript');
  assert.equal(detectCodeLanguage(['var x = 1;', 'console.log(x);']), 'javascript');
  assert.equal(detectCodeLanguage([
    'const url = "https://example.com"; // 中文注释',
    'console.log(url);',
  ]), 'javascript');
});
