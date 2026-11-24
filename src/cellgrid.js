/**
 * Cell-grid table reconstruction: cluster per-cell rectangles into a grid,
 * project positioned text items into cells, join each cell into one sentence.
 */
import { mul, cluster } from './geom.js';
const norm = s => String(s||'')
  .replace(/：/g,':').replace(/[“”]/g,'"').replace(/[‘’]/g,"'")
  .replace(/([\u4e00-\u9fff]) +(?=[\u4e00-\u9fff])/g,'$1')
  .replace(/ +([，。、；：！？）】》])/g,'$1')
  .replace(/\s+/g,' ').trim();
const NUM_ITEM = /^[+-]?\d[\d,]*\.\d+(?:\s+[+-]?\d[\d,]*\.\d+)+$/;
// Integers, decimals and whitespace-packed runs of them — all single-value
// table cells (age labels, rates). Unlike text, one such cell never spans rows.
const NUMERIC_ITEM = /^[+-]?\d[\d,]*(?:\.\d+)?(?:\s+[+-]?\d[\d,]*(?:\.\d+)?)*$/;

/**
 * Project positioned text items into a rectangular grid. Works for both
 * per-cell rectangle tables and rule-based (legacy) grids: each item is placed
 * by the centre of its bounding box, then cells are joined left→right, top→bottom.
 */
export function projectItemsToGrid(items, colEdges, rowEdges) {
  const xs = [...colEdges].sort((a, b) => a - b);
  const ys = [...rowEdges].sort((a, b) => b - a);
  const NUM_UNIT = /^[+-]?\d[\d,]*\.?\d*[A-Za-z\u4e00-\u9fff%]+$/;
  const colAt = cx => {
    for (let ci = 0; ci < xs.length - 1; ci++) {
      if (cx >= xs[ci] - 3 && cx <= xs[ci + 1] + 3) return ci;
    }
    return -1;
  };
  const startColAt = x0 => {
    for (let ci = 0; ci < xs.length - 1; ci++) {
      if (x0 >= xs[ci] - 5 && x0 < xs[ci + 1] - 3) return ci;
    }
    return -1;
  };
  const rows = Array.from({ length: ys.length - 1 },
    () => Array.from({ length: xs.length - 1 }, () => []));

  // A PDF text baseline hugs the bottom of its own cell. With the old +/-3pt
  // membership test a baseline near a SHARED edge falls into both adjacent row
  // bands, so the same item is written into both — rate tables then show sliding
  // duplicates ("0 1" / "91 90"). Numeric cells always belong to one row, so
  // project them strictly by the band containing their baseline (on an internal
  // edge -> the band above). Text items keep the tolerant multi-band behaviour:
  // a vertically-spread merged cell (e.g. "软件更新与技术支持") relies on it to
  // render all its fragments in every row it spans.
  const rowBands = cy => {
    const out = [];
    for (let ri = 0; ri < ys.length - 1; ri++)
      if (cy <= ys[ri] + 3 && cy >= ys[ri + 1] - 3) out.push(ri);
    return out;
  };
  const numericBand = cy => {
    // A baseline at a shared edge is the BOTTOM of the cell above it. Scanning
    // top-to-bottom with an inclusive bottom edge naturally gives that cell.
    for (let k = 0; k < ys.length - 1; k++)
      if (cy <= ys[k] && cy >= ys[k + 1]) return k;
    // Just outside the grid but still within the tolerant band.
    const bands = rowBands(cy);
    if (!bands.length) return -1;
    return cy > ys[0] ? 0 : bands[bands.length - 1];
  };
  const ON_EDGE = 1;
  const onEdgeRow = cy => {
    for (let k = 1; k < ys.length - 1; k++) {
      if (Math.abs(cy - ys[k]) <= ON_EDGE) return k - 1; // band above edge k
    }
    return -1;
  };

  items.forEach((it, group) => {
    const x = it.transform[4], w = it.width || 0, cy = it.transform[5];
    const str = String(it.str ?? '');
    const numeric = NUMERIC_ITEM.test(str.trim());
    const edgeRow = onEdgeRow(cy);
    const targetRows = numeric
      ? [numericBand(cy)]
      : (edgeRow >= 0 ? [edgeRow] : rowBands(cy));
    if (!targetRows.length || targetRows[0] < 0) return; // outside every row band -> not table content
    // A PDF text item can pack several adjacent cells into one run
    // ("144.89 114.24 91.91"). Projecting the whole run by its centre piles
    // every number into a single cell. Split whitespace-separated tokens by
    // their estimated character position so each lands in its own column.
    const tokens = str.trim().split(/\s+/).filter(Boolean);
    // Only pure numeric runs ("144.89 114.24 91.91") pack several adjacent
    // cells into one PDF text item. Text runs must stay in the column they
    // start in; splitting them by estimated character position misplaces
    // headers. This is content-agnostic — no domain vocabulary involved.
    const parts = [];
    if (NUM_ITEM.test(str.trim())) {
      let off = 0;
      for (const tok of tokens) {
        const idx = str.indexOf(tok, off);
        const tx = x + w * (idx / (str.length || 1));
        const tw = w * (tok.length / (str.length || 1));
        const ci = colAt(tx + tw / 2);
        if (ci >= 0) parts.push({ ci, str: tok, y: cy, x: tx, group });
        off = idx + tok.length;
      }
    } else {
      const ci = NUM_UNIT.test(str.trim()) ? startColAt(x) : colAt(x + w / 2);
      if (ci >= 0) parts.push({ ci, str, y: cy, x, group });
    }
    for (const ri of targetRows)
      for (const part of parts) rows[ri][part.ci].push(part);
  });

  return rows.map(cells => cells.map(parts => {
    parts.sort((a, b) => Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x);
    return norm(parts.map(p => p.str).join(''));
  }));
}

/**
 * A vertically merged cell is one rectangle spanning several row bands, so
 * all of its text belongs to a single logical cell. The per-baseline projection
 * above can leave the last stacked fragment alone in its own row when it sits
 * just below an internal row edge (e.g. "软件更新与技术支" + "持"). Detect that
 * by comparing the rendered cells with the full text gathered from the merged
 * rectangle, and fold the short trailing fragment back into the row above.
 * Splits where both parts are substantial (the long-standing behaviour) are
 * left untouched.
 */
export function foldMergedCellTails(rows, xs, ys, rects, items) {
  const colOf = cx => {
    for (let c = 0; c < xs.length - 1; c++)
      if (cx >= xs[c] - 3 && cx <= xs[c + 1] + 3) return c;
    return -1;
  };
  for (const rect of rects) {
    const top = Math.max(rect.y, rect.y2), bottom = Math.min(rect.y, rect.y2);
    const left = Math.min(rect.x, rect.x2), right = Math.max(rect.x, rect.x2);
    const c = colOf((left + right) / 2);
    if (c < 0) continue;
    // Row bands this rectangle actually spans (more than one => merged cell).
    let rTop = -1, rBot = -1;
    for (let r = 0; r < ys.length - 1; r++) {
      const bandTop = ys[r], bandBot = ys[r + 1];
      if (top >= bandBot && bottom <= bandTop) {
        if (rTop < 0) rTop = r;
        rBot = r;
      }
    }
    if (rTop < 0 || rBot <= rTop) continue;
    // Full text of the merged cell: every item whose centre sits in the rect.
    const its = items.filter(it => {
      const x = it.transform[4], w = it.width || 0, y = it.transform[5];
      const cx = x + w / 2;
      return cx >= left - 3 && cx <= right + 3 && y <= top + 3 && y >= bottom - 3 &&
        String(it.str ?? '').trim();
    }).sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
    const full = norm(its.map(it => it.str).join(''));
    if (full.length < 4) continue;
    // Locate the last two non-empty rows of this column inside the merge.
    let last = -1, prev = -1;
    for (let r = rTop; r <= rBot; r++) {
      if (!String(rows[r][c] ?? '').trim()) continue;
      prev = last; last = r;
    }
    if (prev < 0 || last <= prev) continue;
    const tail = String(rows[last][c] ?? '').trim();
    const head = String(rows[prev][c] ?? '').trim();
    // Fold only a short trailing fragment that completes the full cell text.
    if (tail.length > 4 || tail.length >= full.length * 0.3) continue;
    if (full !== head + tail) continue;
    rows[prev][c] = full;
    rows[last][c] = '';
  }
  return rows;
}

/** Build tables from cell rectangles. Returns {tables, consumedY ranges}. */
export function cellGridTables(opList, OPS, items, options={}) {
  const rects=[]; const stack=[]; let ctm=[1,0,0,1,0,0];
  const ap=(m,x,y)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
  for(let i=0;i<opList.fnArray.length;i++){
    const fn=opList.fnArray[i];
    if(fn===OPS.save){stack.push([...ctm]);continue;}
    if(fn===OPS.restore){ctm=stack.pop()||ctm;continue;}
    if(fn===OPS.transform){ctm=mul(ctm,opList.argsArray[i]);continue;}
    if(fn!==OPS.constructPath)continue;
    const [ops,shapes]=opList.argsArray[i];
    const flat=shapes.length>0&&typeof shapes[0]==='number';
    const arr=flat?[shapes]:shapes;
    for(let j=0;j<arr.length;j++){
      const op=ops.length===1?ops[0]:ops[j], r=arr[j];
      if(op!==(OPS.rectangle??19)||!Array.isArray(r)||r.length!==4)continue;
      const [x,y,w,h]=r; if(w<8||h<8||w>600||h>780)continue;
      const a=ap(ctm,x,y), b=ap(ctm,x+w,y+h);
      rects.push({x:Math.min(a[0],b[0]),y:Math.min(a[1],b[1]),x2:Math.max(a[0],b[0]),y2:Math.max(a[1],b[1])});
    }
  }
  if(!rects.length)return {tables:[],rects:[]};
  // Column boundaries: rect left/right edges repeated across many rectangles.
  const xEdges=cluster(rects.flatMap(r=>[r.x,r.x2]),2.5);
  if(xEdges.length<3)return {tables:[],rects};
  const tables=[];
  // Connected components: rects touch if x edges or y edges align and ranges overlap.
  const parent=rects.map((_,i)=>i);
  const find=a=>parent[a]===a?a:(parent[a]=find(parent[a]));
  const uni=(a,b)=>{parent[find(a)]=find(b);};
  for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){
    const a=rects[i],b=rects[j];
    const xTouch=Math.abs(a.x-b.x)<2.5||Math.abs(a.x-b.x2)<2.5||Math.abs(a.x2-b.x)<2.5||Math.abs(a.x2-b.x2)<2.5;
    const yTouch=Math.abs(a.y-b.y)<2.5||Math.abs(a.y-b.y2)<2.5||Math.abs(a.y2-b.y)<2.5||Math.abs(a.y2-b.y2)<2.5;
    const xOverlap=a.x<b.x2-1&&b.x<a.x2-1, yOverlap=a.y<b.y2-1&&b.y<a.y2-1;
    if((xTouch&&yOverlap)||(yTouch&&xOverlap))uni(i,j);
  }
  const comps=new Map(); rects.forEach((r,i)=>{const k=find(i);if(!comps.has(k))comps.set(k,[]);comps.get(k).push(r);});
  for(const rs of comps.values()){
    if(rs.length<4)continue;
    const xs=cluster(rs.flatMap(r=>[r.x,r.x2]),2.5).sort((a,b)=>a-b);
    const ys=cluster(rs.flatMap(r=>[r.y,r.y2]),2.5).sort((a,b)=>b-a);
    if(xs.length<3||ys.length<3)continue;
    const top=ys[0],bottom=ys[ys.length-1],left=xs[0],right=xs[xs.length-1];
    if(right-left<120||top-bottom<40)continue;
    let rows = projectItemsToGrid(items, xs, ys);
    rows = foldMergedCellTails(rows, xs, ys, rs, items);
    // A decorative background over prose is drawn as a handful of large
    // rectangles, not one rect per cell. A real grid has far more rects than
    // rows+cols; use that ratio to reject prose that happens to sit in boxes.
    const cells = (ys.length-1)*(xs.length-1);
    if (rs.length < cells*0.6) continue;
    tables.push({top,bottom,left,right,colEdges:xs,rowEdges:ys,rows,source:'cellgrid'});
  }
  return {tables,rects};
}
