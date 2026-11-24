# Copyright (c) MinerU local tooling. All rights reserved.
"""MinerU 跨页表格“截断行续接”离线修复扩展。

MinerU 把跨页表格拆成上下两张表（下页首表带 ``continues_prev``）。渲染阶段会把
两张表合并，但默认只做“整行追加”：如果分页恰好把同一个逻辑行从中间截断，
上页最后一行只有上半截、下页第一行只有下半截，合并后就会变成两行，并且文字
在词中被切断（例如“所属板”/“块”、“参数完”/“整性”）。

官方在线的做法是用外部 LLM 生成 ``cell_merge``（见
``mineru/backend/postprocess/table_merge/llm_cell_merge.py``），但桌面离线环境没有
LLM 端点。本模块改用离线启发式判断边界两行是否属于同一逻辑行；确认后给下页
表格写入全 1 的 ``cell_merge``，由 docvortex 既有的 ``_apply_cell_merge``
（``docvortex/content/table/content.py``）按视觉列把下页首行并回上一行并折叠该行。

设计取舍：逐行 all-or-nothing（整行续接或完全不处理），并且仅在“没有独立
记录证据”时才合并，宁可漏修也不要把两条不同记录粘在一起。

环境变量：
- ``MINERU_EXT_CROSS_PAGE=0`` 关闭本扩展（默认开启）。
- ``MINERU_EXT_STRICT=1`` 只接受强证据（分隔符、闭合标点、拉丁词中截断）。
- ``MINERU_EXT_DEBUG=1`` 输出每个候选的判定分数与依据。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import traceback
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

if TYPE_CHECKING:  # 仅用于类型标注，运行时延迟导入，避免拖慢应用启动。
    from docvortex.content.table import RenderedCellSegment
    from mineru.types import MiddleJson, PageInfo, TableBlock

logger = logging.getLogger(__name__)

ENV_ENABLE = "MINERU_EXT_CROSS_PAGE"
ENV_STRICT = "MINERU_EXT_STRICT"
ENV_DEBUG = "MINERU_EXT_DEBUG"

# 句末标点：出现即认为该片段已经自成一句，不再视为被截断。
_TERMINAL_CHARS = frozenset("。！？!?…")
# 片段结尾的闭合符号：同样表示内容已收口。
_CLOSING_CHARS = frozenset("）)]】》〉」”’\"'")
# 片段结尾的分隔符：说明后面还有内容，是“被截断”的强信号。
_SEPARATOR_CHARS = frozenset("，、；：,;:—-–/·|（(【[《〈“\"'")
# 下页片段以这些字符开头时，只可能是上半截的延续，不可能是独立新值。
_CONTINUATION_HEAD_CHARS = frozenset("）)]】》〉」”’\"'，、；：。！？,;:.!?")
# 片段结尾的任意标点：句末、闭合与分隔符号（用于行级“不是截断”判定）。
_PUNCTUATION_CHARS = _TERMINAL_CHARS | _CLOSING_CHARS | _SEPARATOR_CHARS
# 真正表示“这句话已经说完”的符号：句末标点与括号类闭合符。
# 引号不算：它常在一句话中间收口（如“出现‘金针探底’形态，请注意观察。”），
# 后半句仍可能被分页截断到下一页。
_SENTENCE_END_CHARS = _TERMINAL_CHARS | frozenset("）)]】》〉」")

# 常见“行首短语”：下页首行若以它们开头，更像一条独立记录而非词中截断。
_ROW_START_TOKENS = (
    "负责",
    "提供",
    "支持",
    "实现",
    "当前",
    "目前",
    "结合",
    "根据",
    "通过",
    "采用",
    "包括",
    "主要",
    "本",
    "该",
    "其",
    "这",
    "那",
    "我",
    "你",
    "他",
    "它",
    "由",
    "从",
)

_CJK_RANGES = (
    (0x3040, 0x30FF),  # 日文假名
    (0x3400, 0x4DBF),  # 扩展 A
    (0x4E00, 0x9FFF),  # 基本区
    (0xAC00, 0xD7AF),  # 韩文音节
    (0xF900, 0xFAFF),  # 兼容表意
)

_FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
_NUMERIC_LIKE = re.compile(r"^[\s0-9,，.．%‰+\-－—–()（）¥$€£元万亿千百十/]+$")
_DIGIT = re.compile(r"[0-9]")


# ---------------------------------------------------------------- 对外入口


def fix_parse_result(result: Any, *, strict: bool | None = None) -> int:
    """在 ``ParseResult`` 渲染前修复跨页表格截断行，返回处理的表格对数。

    渲染是惰性的（``markdown()``/``to_json()``/``structured_content()`` 均在调用时
    才读取 ``middle_json``），因此在返回给调用方之前修改即可生效。
    """
    if not _enabled():
        return 0
    middle_json = getattr(result, "middle_json", None)
    if middle_json is None:
        return 0
    return fix_middle_json(middle_json, strict=strict)


def fix_middle_json(middle_json: Any, *, strict: bool | None = None) -> int:
    """直接修复 ``MiddleJson`` 对象，返回处理的表格对数。"""
    if not _enabled():
        return 0
    pages = getattr(middle_json, "pages", None)
    if not pages:
        return 0
    debug = _debug_enabled()
    strict_mode = _strict_enabled() if strict is None else strict
    fixed = 0
    pairs = _find_continued_table_pairs(pages)
    if debug:
        logger.info("mineru_ext: 候选跨页续表对 %d 个", len(pairs))
    for previous_page_idx, current_page_idx, previous_table, current_table in pairs:
        try:
            if _apply_heuristic(
                previous_table,
                current_table,
                label=f"page {previous_page_idx}/{previous_table.index} -> {current_page_idx}/{current_table.index}",
                strict=strict_mode,
                debug=debug,
            ):
                fixed += 1
        except Exception:  # 单个候选失败不能影响整篇文档的其余候选。
            logger.debug("跨页表格续行判定失败，已跳过该候选", exc_info=True)
    if fixed:
        logger.info("mineru_ext: 修复跨页表格截断行 %d 处", fixed)
    try:
        folded = _merge_continuation_head_rows(pages, debug=debug)
    except Exception:  # 折行合并失败同样不能影响解析结果。
        logger.debug("续表首行折行合并失败，已跳过", exc_info=True)
    else:
        if folded:
            logger.info("mineru_ext: 修复续表首行折行 %d 处", folded)
    return fixed


# ---------------------------------------------------------------- 候选定位


def _find_continued_table_pairs(
    pages: list["PageInfo"],
) -> list[tuple[int, int, "TableBlock", "TableBlock"]]:
    """按相邻页面查找已由确定性规则标记的跨页续表对（含两侧页号，便于日志定位）。"""
    from mineru.types import TableBlock

    pairs: list[tuple[int, int, TableBlock, TableBlock]] = []
    for previous_page, current_page in zip(pages, pages[1:]):
        if current_page.page_idx != previous_page.page_idx + 1:
            continue
        current_table = next(
            (block for block in current_page.blocks if isinstance(block, TableBlock) and block.continues_prev is True),
            None,
        )
        if current_table is None or current_table.cell_merge is not None:
            continue
        previous_table = next(
            (block for block in reversed(previous_page.blocks) if isinstance(block, TableBlock)),
            None,
        )
        if previous_table is not None:
            pairs.append((previous_page.page_idx, current_page.page_idx, previous_table, current_table))
    return pairs


def _table_body_html(table: "TableBlock") -> str | None:
    """读取严格 table 根块下唯一主体的 HTML 内容。"""
    from mineru.types import TableBodyBlock

    for child in table.content:
        if isinstance(child, TableBodyBlock):
            return child.content or None
    return None


# ------------------------------------------------------ 续表首行折行合并

# 这些片段开头意味着另起一条记录/说明，不能当作上一行的折行续写。
_FOLDED_ROW_NEW_RECORD_PREFIXES = ("注", "备注", "说明", "合计", "总计", "小计", "单位", "续表")


def _merge_continuation_head_rows(pages: list["PageInfo"], *, debug: bool = False) -> int:
    """续表首行若被页内折行拆成两行，就并回第一行；其他页内行不处理。"""
    from bs4 import BeautifulSoup

    from mineru.types import TableBlock, TableBodyBlock

    merged = 0
    for page in pages:
        for block in page.blocks:
            if not isinstance(block, TableBlock) or block.continues_prev is not True:
                continue
            body = next((child for child in block.content if isinstance(child, TableBodyBlock)), None)
            if body is None or not body.content:
                continue
            soup = BeautifulSoup(body.content, "html.parser")
            rows = soup.find_all("tr")
            if len(rows) < 2:
                continue
            if not _try_merge_folded_row(rows[0], rows[1]):
                continue
            body.content = str(soup)
            merged += 1
            if debug:
                logger.info("mineru_ext: page %s 表 %s 续表首行折行已合并", page.page_idx, block.index)
    return merged


def _try_merge_folded_row(previous_row: Any, current_row: Any) -> bool:
    """当前行若只剩一列有内容且与上一行同列相接，则视为折行并回上一行。"""
    from docvortex.content.table.content import _append_cell_content

    previous_cells = previous_row.find_all(["td", "th"], recursive=False)
    current_cells = current_row.find_all(["td", "th"], recursive=False)
    if len(current_cells) < 3 or len(previous_cells) != len(current_cells):
        return False
    # 跨行/跨列的单元格会把列号错位，无法可靠对齐，直接放弃。
    if any(cell.has_attr("rowspan") or cell.has_attr("colspan") for cell in (*previous_cells, *current_cells)):
        return False
    filled = [index for index, cell in enumerate(current_cells) if cell.get_text(strip=True)]
    if len(filled) != 1:
        return False
    column = filled[0]
    fragment = current_cells[column].get_text(strip=True)
    if fragment.startswith(_FOLDED_ROW_NEW_RECORD_PREFIXES):
        return False
    target = previous_cells[column]
    previous_text = target.get_text(strip=True)
    if not previous_text or _ends_punctuation(previous_text):
        return False
    if _starts_row_phrase(fragment):
        return False
    _append_cell_content(target, current_cells[column])
    current_row.extract()
    return True


# ---------------------------------------------------------------- 判定与写入


def _apply_heuristic(
    previous_table: "TableBlock",
    current_table: "TableBlock",
    *,
    label: str,
    strict: bool,
    debug: bool,
) -> bool:
    """计算边界行，判定为同一逻辑行时写入全 1 的 cell_merge。"""
    from docvortex.content.table import (
        build_row_rendered_cell_segments,
        build_table_state_from_html,
        detect_table_headers,
        expand_header_count_by_rowspan,
    )

    def skip(reason: str) -> bool:
        if debug:
            logger.info("mineru_ext: %s merge=False reason=%s", label, reason)
        return False

    previous_html = _table_body_html(previous_table)
    current_html = _table_body_html(current_table)
    if previous_html is None or current_html is None:
        return skip("缺少表格主体 HTML")

    previous_state = build_table_state_from_html(previous_html)
    current_state = build_table_state_from_html(current_html)
    if previous_state is None or current_state is None or previous_state.total_cols <= 0:
        return skip("表格状态解析失败")

    header_count, _, _ = detect_table_headers(previous_state, current_state)
    header_count = expand_header_count_by_rowspan(current_state.rows, header_count)
    previous_metrics = previous_state.last_data_row_metrics
    current_metrics = current_state.front_first_data_row_metrics.get(header_count)
    if previous_metrics is None or current_metrics is None:
        return skip(f"取不到边界数据行（header_count={header_count}）")

    previous_segments = build_row_rendered_cell_segments(previous_state.rows, previous_metrics.row_idx)
    current_segments = build_row_rendered_cell_segments(current_state.rows, current_metrics.row_idx)
    if not previous_segments or len(previous_segments) != len(current_segments):
        return skip(f"边界行视觉列数不一致：{len(previous_segments)} vs {len(current_segments)}")

    merge, score, reason = _evaluate_boundary_row(previous_segments, current_segments, strict=strict)
    if debug:
        logger.info(
            "mineru_ext: %s merge=%s score=%s reason=%s cols=%s prev=%s cur=%s",
            label,
            merge,
            score,
            reason,
            previous_state.total_cols,
            _preview(_segments_text(previous_segments)),
            _preview(_segments_text(current_segments)),
        )
    if not merge:
        return False

    # 官方 cell_merge 通道要求长度等于前表视觉列数；整行续接直接用全 1。
    current_table.cell_merge = [1] * previous_state.total_cols
    return True


def _evaluate_boundary_row(
    previous_segments: list["RenderedCellSegment"],
    current_segments: list["RenderedCellSegment"],
    *,
    strict: bool,
) -> tuple[bool, int, str]:
    """判断上页末行与下页首行是否属于被分页截断的同一逻辑行。

    返回 ``(是否合并, 分数, 依据)``。任一列出现“确定是新记录”的证据即整体放弃。
    """
    # 上页末行除首列外每一列都以标点收口：各格内容都已完结，不可能是被分页
    # 截断的同一逻辑行（首列常是跨行长文本，允许它没有标点）。
    if _secondary_columns_end_punctuation(previous_segments):
        return False, 0, "上页末行除首列外均以标点结尾（不是截断）"

    score = 0
    reasons: list[str] = []
    strong = False
    cjk_pairs = 0
    comparable = 0
    blank_columns = 0

    for previous, current in zip(previous_segments, current_segments):
        previous_text = previous.text.strip()
        current_text = current.text.strip()
        previous_has = bool(previous_text) or previous.has_non_text_content
        current_has = bool(current_text) or current.has_non_text_content

        if previous_has and not current_has:
            # 上页有内容、下页为空：典型的“格子被整块切走”，是续接的结构信号。
            blank_columns += 1
            continue
        if not previous_has or not current_has:
            continue
        if previous.has_non_text_content and current.has_non_text_content:
            return False, 0, "同一列上下都有非文本内容"

        comparable += 1

        if previous_text == current_text:
            return False, 0, "同一列上下文本完全重复"
        if _normalize_template(previous_text) == _normalize_template(current_text):
            return False, 0, "同一列上下模板相同（疑似不同记录，如编号递增）"
        if _shared_prefix_len(previous_text, current_text) >= 2 and min(
            len(previous_text), len(current_text)
        ) >= 4:
            return False, 0, "同一列上下共享前缀（疑似并列记录）"
        if _ends_terminal(previous_text):
            return False, 0, "上侧以句末或闭合符号结尾"
        if _starts_row_phrase(current_text) and not _ends_separator(previous_text):
            return False, 0, f"下侧以独立行首短语开头：{current_text[:2]}"

        # 短的一行文字无法跨页截断（截断的是“高格子”里的多行内容），
        # 因此上下都短时几乎可以确定是两条并列记录。
        if len(previous_text) <= 6 and len(current_text) <= 6:
            return False, 0, "同一列上下都过短（疑似并列短值）"
        if _is_numeric_like(previous_text) and _is_numeric_like(current_text):
            return False, 0, "同一列上下都是纯数字"

        if _ends_separator(previous_text) or _starts_continuation(current_text):
            strong = True
        if _ends_latin(previous_text) and _starts_latin(current_text):
            strong = True
        if _ends_cjk(previous_text) and _starts_cjk(current_text):
            cjk_pairs += 1

    if comparable == 0:
        return False, 0, "边界行没有可比较的非空列"

    if strong:
        score += 2
        reasons.append("强截断标记")
    score += min(cjk_pairs, 2)
    if cjk_pairs:
        reasons.append(f"中日韩字符边界 {cjk_pairs} 列")
    if blank_columns:
        if blank_columns >= len(previous_segments) - 1:
            # 下页首行只剩一列有数据：整行其余格子都被分页线切走，续接特征极强。
            score += 2
            reasons.append("下页仅剩一列有数据")
        elif len(previous_segments) > 2 and blank_columns >= 2:
            # 多列同时被切走比单列更有说服力：并列记录很难刚好让多个格子同时为空。
            score += 1
            reasons.append(f"下页多列缺失 {blank_columns} 列")
        else:
            score += 1
            reasons.append("下页整列缺失")
    # 走到这里说明所有列都没有“确定是新记录”的证据，属于未完结边界。
    score += 1
    reasons.append("无明显独立记录证据")

    threshold = 2 if not strict else 3
    if strict and not strong:
        return False, score, "严格模式且无强证据"
    if score < threshold:
        return False, score, "分数不足：" + "+".join(reasons)
    return True, score, "+".join(reasons)


# ---------------------------------------------------------------- 文本工具


def _normalize_template(text: str) -> str:
    """把数字掩成统一占位，用于发现“同模板不同值”的并列记录。"""
    stripped = re.sub(r"\s+", "", text).translate(_FULLWIDTH_DIGITS)
    return re.sub(r"[0-9]+", "#", stripped)


def _shared_prefix_len(left: str, right: str) -> int:
    """返回两段文本的公共前缀长度（按字符计）。"""
    limit = min(len(left), len(right))
    for index in range(limit):
        if left[index] != right[index]:
            return index
    return limit


def _ends_terminal(text: str) -> bool:
    """上侧文本是否已以句末标点或括号类闭合符号收口（引号不算收口）。"""
    return bool(text) and text[-1] in _SENTENCE_END_CHARS


def _ends_separator(text: str) -> bool:
    """上侧文本是否以逗号、顿号、冒号、连接号等分隔符结尾。"""
    return bool(text) and text[-1] in _SEPARATOR_CHARS


def _starts_continuation(text: str) -> bool:
    """下侧片段是否以下半句才可能出现的闭合/分隔标点开头。"""
    return bool(text) and text[0] in _CONTINUATION_HEAD_CHARS


def _ends_punctuation(text: str) -> bool:
    """文本是否以任意标点（句末、闭合或分隔）结尾。"""
    return bool(text) and text[-1] in _PUNCTUATION_CHARS


def _starts_row_phrase(text: str) -> bool:
    """下侧片段是否以独立行首短语开头（短语后紧跟标点时不算，如“本、生产包”）。"""
    for token in _ROW_START_TOKENS:
        if not text.startswith(token):
            continue
        rest = text[len(token):].lstrip()
        return not (rest and rest[0] in _PUNCTUATION_CHARS | _CONTINUATION_HEAD_CHARS)
    return False


def _secondary_columns_end_punctuation(segments: Iterable["RenderedCellSegment"]) -> bool:
    """上页末行除首列外，每一列都有内容且以标点结尾。"""
    columns = list(segments)[1:]
    if not columns:
        return False
    return all(_ends_punctuation(segment.text.strip()) for segment in columns)


def _ends_latin(text: str) -> bool:
    return bool(text) and text[-1].isascii() and text[-1].isalpha()


def _starts_latin(text: str) -> bool:
    return bool(text) and text[0].isascii() and text[0].isalpha()


def _is_cjk(char: str) -> bool:
    code = ord(char)
    return any(start <= code <= end for start, end in _CJK_RANGES)


def _ends_cjk(text: str) -> bool:
    return bool(text) and _is_cjk(text[-1])


def _starts_cjk(text: str) -> bool:
    return bool(text) and _is_cjk(text[0])


def _is_numeric_like(text: str) -> bool:
    normalized = text.translate(_FULLWIDTH_DIGITS).strip()
    return bool(normalized) and bool(_DIGIT.search(normalized)) and bool(_NUMERIC_LIKE.match(normalized))


def _segments_text(segments: Iterable["RenderedCellSegment"]) -> list[str]:
    return [segment.text.strip() for segment in segments]


def _preview(values: list[str], limit: int = 24) -> str:
    """拼接列文本并截断，仅用于调试日志。"""
    joined = " | ".join(value for value in values if value)
    return joined[:limit] + ("…" if len(joined) > limit else "")


# ---------------------------------------------------------------- 开关


def _enabled() -> bool:
    return os.environ.get(ENV_ENABLE, "1").strip().lower() not in {"0", "false", "off", "no"}


def _strict_enabled() -> bool:
    return os.environ.get(ENV_STRICT, "").strip().lower() in {"1", "true", "on", "yes"}


def _debug_enabled() -> bool:
    return os.environ.get(ENV_DEBUG, "").strip().lower() in {"1", "true", "on", "yes"}


# ---------------------------------------------------------------- 命令行


def main(argv: list[str] | None = None) -> int:
    """离线修复 middle.json（调试/回归用，不参与在线解析链路）。"""
    parser = argparse.ArgumentParser(description="修复 MinerU middle.json 中的跨页表格截断行")
    parser.add_argument("middle_json", help="middle.json 路径")
    parser.add_argument("-o", "--output", help="输出路径；缺省时只打印统计")
    parser.add_argument("--strict", action="store_true", help="只接受强证据")
    parser.add_argument("--debug", action="store_true", help="打印每个候选的判定依据")
    args = parser.parse_args(argv)

    if args.debug:
        logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.strict:
        os.environ[ENV_STRICT] = "1"

    from mineru.types import MiddleJson

    source = Path(args.middle_json)
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
        middle_json = MiddleJson.from_dict(payload)
    except Exception:
        traceback.print_exc()
        print(f"无法读取 middle.json：{source}", file=sys.stderr)
        return 1

    fixed = fix_middle_json(middle_json, strict=args.strict)
    print(f"修复跨页表格截断行：{fixed} 处")
    if args.output:
        Path(args.output).write_text(
            json.dumps(middle_json.to_dict(skip_defaults=False), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"已写出：{args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
