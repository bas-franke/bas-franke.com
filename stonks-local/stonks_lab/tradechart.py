"""Self-contained HTML trade charts for a backtest: every buy and sell on the price, sized by EUR, plus equity,
exposure, a full trade table and closed round trips.

    from stonks_lab import tradechart
    html = tradechart.render(result, bh_result, candles, title="...", hypothesis="...")

The page has no external dependencies (inline SVG + JS), works offline and follows the OS light/dark theme.
"""
from __future__ import annotations

import csv
import datetime as dt
import html as _html
import json
from pathlib import Path

import numpy as np

from .backtest import BacktestResult

MAX_PRICE_POINTS = 60_000  # per market; longer histories are min/max decimated (trades are always kept exactly)


def _iso(ts_ms: int) -> str:
    return dt.datetime.fromtimestamp(int(ts_ms) / 1000, dt.timezone.utc).strftime("%Y-%m-%d %H:%M")


def _decimate(ts: np.ndarray, c: np.ndarray, max_points: int) -> tuple[list, list]:
    ok = np.isfinite(c)
    ts, c = ts[ok], c[ok]
    n = len(c)
    if n <= max_points:
        return ts.tolist(), np.round(c, 8).tolist()
    k = int(np.ceil(n / (max_points / 2)))
    out_t, out_c = [], []
    for a in range(0, n, k):
        seg = c[a:a + k]
        i, j = int(np.argmin(seg)), int(np.argmax(seg))
        for q in sorted({i, j}):
            out_t.append(int(ts[a + q]))
            out_c.append(round(float(seg[q]), 8))
    return out_t, out_c


def trade_rows(res: BacktestResult) -> list[dict]:
    """Every fill with derived columns: P&L %, holding time of closed positions, equity right after the fill."""
    ts = np.asarray(res.ts, dtype=np.int64)
    opened: dict[str, int] = {}
    rows = []
    for k, t in enumerate(res.trades):
        i = min(int(np.searchsorted(ts, int(t["time"]), side="left")), len(ts) - 1)
        m = t["market"]
        row = {
            "n": k + 1, "time": int(t["time"]), "date": _iso(t["time"]), "market": m, "side": t["side"],
            "price": float(t["price"]), "amount": float(t["amount"]), "eur": float(t["eur"]), "fee": float(t["fee"]),
            "liquidity": t.get("liquidity"), "reason": t.get("reason") or "", "pnl": None, "pnlPct": None,
            "closed": bool(t.get("closed")), "heldDays": None, "equityAfter": round(float(res.equity[i]), 2),
        }
        if t["side"] == "buy":
            opened.setdefault(m, int(t["time"]))
        else:
            pnl = float(t.get("pnl", 0.0))
            cost = float(t["eur"]) - float(t["fee"]) - pnl
            row["pnl"] = pnl
            row["pnlPct"] = pnl / cost * 100 if cost > 0 else None
            if m in opened:
                row["heldDays"] = (int(t["time"]) - opened[m]) / 86_400_000
                if row["closed"]:
                    opened.pop(m)
        rows.append(row)
    return rows


def round_trips(rows: list[dict]) -> list[dict]:
    """Closed positions: first buy -> the sell that closes it, with every partial fill in between."""
    out, cur = [], {}
    for r in rows:
        m = r["market"]
        p = cur.setdefault(m, {"market": m, "entry": None, "buys": 0, "sells": 0, "invested": 0.0, "returned": 0.0,
                               "fees": 0.0, "pnl": 0.0, "coins": 0.0})
        if r["side"] == "buy":
            if p["entry"] is None:
                p["entry"] = r["time"]
            p["buys"] += 1
            p["invested"] += r["eur"]
            p["coins"] += r["amount"]
        else:
            p["sells"] += 1
            p["returned"] += r["eur"]
            p["pnl"] += r["pnl"] or 0.0
        p["fees"] += r["fee"]
        if r["side"] == "sell" and r["closed"]:
            p["exit"] = r["time"]
            p["avgEntry"] = p["invested"] / p["coins"] if p["coins"] else None
            p["avgExit"] = r["price"]
            p["pnlPct"] = p["pnl"] / (p["invested"] + p["fees"]) * 100 if p["invested"] else None
            p["days"] = (p["exit"] - p["entry"]) / 86_400_000 if p["entry"] is not None else None
            out.append(p)
            cur.pop(m)
    for p in cur.values():  # still open at the end of the window
        if p["entry"] is not None:
            out.append({**p, "exit": None, "avgEntry": p["invested"] / p["coins"] if p["coins"] else None,
                        "avgExit": None, "pnlPct": None, "days": None})
    return out


def payload(res: BacktestResult, bh: BacktestResult | None, candles: dict, *, title: str, hypothesis: str = "",
            explain: dict | None = None) -> dict:
    ts = np.asarray(res.ts, dtype=np.int64)
    a, b = int(ts[0]), int(ts[-1])
    prices = {}
    for m in res.markets:
        df = candles[m]
        idx = np.asarray(df.index, dtype=np.int64)
        sel = (idx >= a) & (idx <= b)
        t, c = _decimate(idx[sel], df["close"].to_numpy(np.float64)[sel], MAX_PRICE_POINTS)
        prices[m] = {"t": t, "c": c}
    et, ev = _decimate(ts, np.asarray(res.equity, np.float64), MAX_PRICE_POINTS)
    rows = trade_rows(res)
    out = {
        "title": title, "hypothesis": hypothesis, "spec": res.spec, "explain": explain or {},
        "interval": res.interval, "startEur": res.start_eur, "metrics": res.metrics,
        "prices": prices, "equity": {"t": et, "v": ev},
        "exposure": {"t": et, "v": [round(float(x), 4) for x in
                                    np.interp(et, ts, np.asarray(res.exposure, np.float64))]},
        "trades": rows, "roundTrips": round_trips(rows),
    }
    if bh is not None:
        bt_, bv = _decimate(np.asarray(bh.ts, np.int64), np.asarray(bh.equity, np.float64), MAX_PRICE_POINTS)
        out["buyHold"] = {"t": bt_, "v": bv, "metrics": bh.metrics}
    return out


def render(res: BacktestResult, bh: BacktestResult | None, candles: dict, *, title: str, hypothesis: str = "",
           explain: dict | None = None) -> str:
    data = payload(res, bh, candles, title=title, hypothesis=hypothesis, explain=explain)
    blob = json.dumps(data, separators=(",", ":"), default=float).replace("</", "<\\/")
    return _TEMPLATE.replace("__TITLE__", _html.escape(title)).replace("__DATA__", blob)


def write(path: str | Path, res: BacktestResult, bh: BacktestResult | None, candles: dict, **kw) -> Path:
    """Write the HTML chart and a CSV of every trade next to it (same name, .trades.csv). Returns the HTML path."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(res, bh, candles, **kw), encoding="utf-8")
    cols = ["n", "date", "market", "side", "price", "amount", "eur", "fee", "liquidity", "reason", "pnl", "pnlPct",
            "heldDays", "equityAfter"]
    with open(path.with_suffix(".trades.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(trade_rows(res))
    return path


_TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e6e3dd;--grid:#efede8;--price:#3d3c38;
--buy:#1a8a4a;--sell:#c8372d;--win:#1a8a4a;--loss:#c8372d;--eq:#2f5fd0;--bh:#a39f96;--hold:rgba(26,138,74,.08);
--sel:rgba(47,95,208,.12)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161615;--panel:#1f1f1d;--ink:#ecebe7;
--muted:#9b9992;--line:#34332f;--grid:#2a2926;--price:#d8d6cf;--buy:#3fbf73;--sell:#ef6a5f;--win:#3fbf73;
--loss:#ef6a5f;--eq:#7aa2ff;--bh:#77746c;--hold:rgba(63,191,115,.10);--sel:rgba(122,162,255,.16)}}
:root[data-theme="dark"]{--bg:#161615;--panel:#1f1f1d;--ink:#ecebe7;--muted:#9b9992;--line:#34332f;--grid:#2a2926;
--price:#d8d6cf;--buy:#3fbf73;--sell:#ef6a5f;--win:#3fbf73;--loss:#ef6a5f;--eq:#7aa2ff;--bh:#77746c;
--hold:rgba(63,191,115,.10);--sel:rgba(122,162,255,.16)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,
"Segoe UI",sans-serif}main{max-width:1280px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}.muted{color:var(--muted)}
.hyp{margin:6px 0 14px;padding:10px 12px;border-left:3px solid var(--eq);background:var(--panel)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:12px 0}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.tile b{display:block;font-size:18px;font-variant-numeric:tabular-nums}.tile span{font-size:12px;color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 10px 4px;margin:10px 0}
.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0}
button{font:inherit;font-size:13px;background:var(--panel);color:var(--ink);border:1px solid var(--line);
border-radius:6px;padding:4px 10px;cursor:pointer}button.on{border-color:var(--eq);color:var(--eq)}
svg{display:block;width:100%;user-select:none}.ax{fill:var(--muted);font-size:11px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);padding:2px 4px 6px}
.legend i{display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:-1px}
#tip{position:fixed;pointer-events:none;background:var(--panel);border:1px solid var(--line);border-radius:6px;
padding:6px 8px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.15);display:none;z-index:5;white-space:nowrap}
.tbl{overflow-x:auto;max-height:560px;overflow-y:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
th,td{padding:5px 8px;border-bottom:1px solid var(--grid);text-align:right;white-space:nowrap}
th{position:sticky;top:0;background:var(--panel);color:var(--muted);font-weight:600}
td.l,th.l{text-align:left}tr.buy td.side{color:var(--buy);font-weight:600}tr.sell td.side{color:var(--sell);
font-weight:600}tbody tr{cursor:pointer}tbody tr:hover{background:var(--sel)}.pos{color:var(--win)}.neg{color:var(--loss)}
details{margin:8px 0}summary{cursor:pointer;color:var(--muted)}pre{white-space:pre-wrap;font-size:12px}
</style></head><body><main>
<h1 id="h"></h1><div class="muted" id="sub"></div><div class="hyp" id="hyp"></div>
<div class="tiles" id="tiles"></div>
<div class="bar" id="ranges"></div>
<div id="charts"></div>
<h2>Every trade</h2>
<div class="bar"><button data-f="all" class="on">All</button><button data-f="buy">Buys</button>
<button data-f="sell">Sells</button><button data-f="win">Winning sells</button><button data-f="loss">Losing sells</button>
<span class="muted" id="tcount"></span><span style="flex:1"></span><button id="csv">Download CSV</button></div>
<div class="tbl"><table id="tt"></table></div>
<h2>Round trips (buy → full sell)</h2>
<div class="tbl"><table id="rt"></table></div>
<details><summary>Spec and explanation</summary><pre id="spec"></pre></details>
</main><div id="tip"></div>
<script>
const D=__DATA__;
const $=s=>document.querySelector(s),fmt=(x,d=2)=>x==null||!isFinite(x)?"–":x.toLocaleString("en",{minimumFractionDigits:d,maximumFractionDigits:d});
const eur=x=>x==null?"–":"€"+fmt(x),pc=x=>x==null?"–":(x>0?"+":"")+fmt(x,1)+" %";
const day=t=>new Date(t).toISOString().slice(0,10),stamp=t=>new Date(t).toISOString().slice(0,16).replace("T"," ");
const pfmt=p=>p>=1000?fmt(p,0):p>=1?fmt(p,2):fmt(p,5);
$("#h").textContent=D.title;
$("#sub").textContent=`${D.spec.family} · ${(D.spec.markets||[]).join(", ")} · ${D.interval} · ${D.metrics.start} → ${D.metrics.end} · start ${eur(D.startEur)}`;
$("#hyp").textContent=D.hypothesis||D.explain.summary||"";if(!$("#hyp").textContent)$("#hyp").remove();
const M=D.metrics,B=D.buyHold?D.buyHold.metrics:{};
const tiles=[["Final",eur(M.finalEur)],["Return",pc(M.returnPct)],["Buy & hold",pc(B.returnPct)],["CAGR",pc(M.cagrPct)],
["Max drawdown",pc(-M.maxDrawdownPct)],["B&H drawdown",pc(B.maxDrawdownPct==null?null:-B.maxDrawdownPct)],["Sharpe",fmt(M.sharpe)],
["Buys / sells",`${M.buys} / ${M.sells}`],["Win rate",M.winRatePct==null?"–":fmt(M.winRatePct,0)+" %"],
["Fees paid",eur(M.feesEur)],["Time invested",M.exposurePct==null?"–":fmt(M.exposurePct,0)+" %"]];
$("#tiles").innerHTML=tiles.map(([k,v])=>`<div class="tile"><span>${k}</span><b>${v}</b></div>`).join("");
$("#spec").textContent=JSON.stringify(D.spec,null,2)+"\n\n"+[D.explain.summary,...(D.explain.howItWorks||[]),
D.explain.whenItWins&&"Wins: "+D.explain.whenItWins,D.explain.whenItLoses&&"Loses: "+D.explain.whenItLoses].filter(Boolean).join("\n");

const T0=D.equity.t[0],T1=D.equity.t[D.equity.t.length-1];let v0=T0,v1=T1,logScale=true,showLabels=true;
const RANGES=[["All",0],["2Y",730],["1Y",365],["6M",182],["3M",91],["1M",30],["1W",7]];
$("#ranges").innerHTML=RANGES.map(([k,d])=>`<button data-d="${d}">${k}</button>`).join("")+
`<span style="flex:1"></span><button id="log" class="on">Log price</button><button id="lbl" class="on">Trade labels</button>
<span class="muted">Drag on a chart to zoom · double-click to reset</span>`;
document.querySelectorAll("#ranges [data-d]").forEach(b=>b.onclick=()=>{const d=+b.dataset.d;v1=T1;v0=d?Math.max(T0,T1-d*864e5):T0;draw();});
$("#log").onclick=e=>{logScale=!logScale;e.target.classList.toggle("on",logScale);draw();};
$("#lbl").onclick=e=>{showLabels=!showLabels;e.target.classList.toggle("on",showLabels);draw();};

const tip=$("#tip");function showTip(ev,html){tip.innerHTML=html;tip.style.display="block";
const x=Math.min(ev.clientX+14,innerWidth-tip.offsetWidth-8),y=Math.min(ev.clientY+14,innerHeight-tip.offsetHeight-8);
tip.style.left=x+"px";tip.style.top=y+"px";}document.addEventListener("scroll",()=>tip.style.display="none");
function tradeTip(r){return `<b style="color:var(--${r.side})">${r.side.toUpperCase()}</b> ${r.market} · ${r.date} UTC<br>
${fmt(r.amount,6)} @ €${pfmt(r.price)} = <b>${eur(r.eur)}</b><br>fee ${eur(r.fee)} (${r.liquidity||"?"}) · ${r.reason}`+
(r.side==="sell"?`<br>P&amp;L <b class="${r.pnl>=0?"pos":"neg"}">${eur(r.pnl)} (${pc(r.pnlPct)})</b>`+
(r.heldDays!=null?` · held ${fmt(r.heldDays,1)} d`:"")+(r.closed?" · position closed":" · partial"):"")+
`<br>equity after ${eur(r.equityAfter)}`;}

function slice(t,v){let a=0,b=t.length;while(a<b){const m=(a+b)>>1;t[m]<v0?a=m+1:b=m;}let e=a;while(e<t.length&&t[e]<=v1)e++;
return[Math.max(0,a-1),Math.min(t.length,e+1)];}
function decim(t,v,a,b,px){const n=b-a,out=[];if(n<=px*2){for(let i=a;i<b;i++)out.push([t[i],v[i]]);return out;}
const k=n/px;for(let s=0;s<px;s++){const i0=a+Math.floor(s*k),i1=Math.min(b,a+Math.floor((s+1)*k));let lo=i0,hi=i0;
for(let i=i0;i<i1;i++){if(v[i]<v[lo])lo=i;if(v[i]>v[hi])hi=i;}if(lo<hi){out.push([t[lo],v[lo]],[t[hi],v[hi]]);}
else if(hi<lo){out.push([t[hi],v[hi]],[t[lo],v[lo]]);}else out.push([t[lo],v[lo]]);}return out;}
const NS="http://www.w3.org/2000/svg";function el(tag,attrs,parent){const e=document.createElementNS(NS,tag);
for(const k in attrs)e.setAttribute(k,attrs[k]);parent&&parent.appendChild(e);return e;}
function niceTicks(lo,hi,n,log){if(log&&lo>0){const out=[];const s=Math.floor(Math.log10(lo)),e=Math.ceil(Math.log10(hi));
for(let p=s;p<=e;p++)for(const m of[1,2,5]){const v=m*10**p;if(v>=lo&&v<=hi)out.push(v);}if(out.length>=2)return out;}
const st=(hi-lo)/n,mg=10**Math.floor(Math.log10(st)),f=st/mg,step=(f<1.5?1:f<3?2:f<7?5:10)*mg,out=[];
for(let v=Math.ceil(lo/step)*step;v<=hi;v+=step)out.push(v);return out;}
function timeTicks(a,b,w){const span=b-a,want=Math.max(2,Math.floor(w/110)),steps=[36e5,6*36e5,864e5,7*864e5,30*864e5,91*864e5,182*864e5,365*864e5];
let st=steps.find(s=>span/s<=want)||steps[steps.length-1];const out=[];let t=Math.ceil(a/st)*st;
if(st>=30*864e5){const d=new Date(a);d.setUTCDate(1);d.setUTCHours(0,0,0,0);const mo=Math.round(st/(30*864e5));
while(d.getTime()<a||d.getUTCMonth()%mo)d.setUTCMonth(d.getUTCMonth()+1);for(;d.getTime()<=b;d.setUTCMonth(d.getUTCMonth()+mo))out.push(d.getTime());return[out,st];}
for(;t<=b;t+=st)out.push(t);return[out,st];}
function tlabel(t,st){const d=new Date(t);if(st>=365*864e5)return d.getUTCFullYear();if(st>=30*864e5)return d.toISOString().slice(0,7);
if(st>=864e5)return d.toISOString().slice(5,10);return d.toISOString().slice(5,16).replace("T"," ");}

function panel(host,{height,series,yfmt,log,band,markers,legend,ylabel}){
const wrap=document.createElement("div");wrap.className="card";host.appendChild(wrap);
if(legend){const lg=document.createElement("div");lg.className="legend";lg.innerHTML=legend;wrap.appendChild(lg);}
const W=Math.max(320,wrap.clientWidth-20),H=height,L=W<560?44:64,R=12,Tp=8,Bt=22,pw=W-L-R,ph=H-Tp-Bt;
const svg=el("svg",{viewBox:`0 0 ${W} ${H}`,height:H},wrap);
let lo=Infinity,hi=-Infinity;const pts=series.map(s=>{const[a,b]=slice(s.t,s.v),d=decim(s.t,s.v,a,b,pw);
d.forEach(p=>{if(p[0]>=v0&&p[0]<=v1&&isFinite(p[1])&&(!log||p[1]>0)){lo=Math.min(lo,p[1]);hi=Math.max(hi,p[1]);}});return d;});
(markers||[]).forEach(m=>{if(m.t>=v0&&m.t<=v1){lo=Math.min(lo,m.p);hi=Math.max(hi,m.p);}});
if(!isFinite(lo)){lo=0;hi=1;}if(lo===hi){lo*=.98;hi*=1.02;}
const useLog=log&&lo>0,f=useLog?Math.log:x=>x,pad=(f(hi)-f(lo))*.06,y0=f(lo)-pad,y1=f(hi)+pad;
const X=t=>L+(t-v0)/(v1-v0)*pw,Y=v=>Tp+(1-(f(v)-y0)/(y1-y0))*ph;
const[tt,st]=timeTicks(v0,v1,pw);tt.forEach(t=>{el("line",{x1:X(t),x2:X(t),y1:Tp,y2:Tp+ph,stroke:"var(--grid)"},svg);
const tx=el("text",{x:X(t),y:H-6,"text-anchor":"middle",class:"ax"},svg);tx.textContent=tlabel(t,st);});
const lov=useLog?Math.exp(y0):y0,hiv=useLog?Math.exp(y1):y1;niceTicks(lov,hiv,5,useLog).forEach(v=>{
el("line",{x1:L,x2:L+pw,y1:Y(v),y2:Y(v),stroke:"var(--grid)"},svg);const tx=el("text",{x:L-6,y:Y(v)+4,"text-anchor":"end",class:"ax"},svg);tx.textContent=yfmt(v);});
if(ylabel){const tx=el("text",{x:4,y:Tp+10,class:"ax"},svg);tx.textContent=ylabel;}
const clip="c"+Math.random().toString(36).slice(2);const cp=el("clipPath",{id:clip},el("defs",{},svg));
el("rect",{x:L,y:0,width:pw,height:H},cp);const g=el("g",{"clip-path":`url(#${clip})`},svg);
(band||[]).forEach(([a,b])=>{if(b<v0||a>v1)return;el("rect",{x:X(Math.max(a,v0)),y:Tp,width:Math.max(1,X(Math.min(b,v1))-X(Math.max(a,v0))),height:ph,fill:"var(--hold)"},g);});
series.forEach((s,k)=>{const d=pts[k].filter(p=>isFinite(p[1])&&(!useLog||p[1]>0)).map((p,i)=>(i?"L":"M")+X(p[0]).toFixed(1)+" "+Y(p[1]).toFixed(1)).join("");
el("path",{d,fill:s.fill?"var(--sel)":"none",stroke:s.color,"stroke-width":s.w||1.4,"stroke-dasharray":s.dash||""},g);});
if(markers){const vis=markers.filter(m=>m.t>=v0&&m.t<=v1),maxE=Math.max(1,...vis.map(m=>m.r.eur)),lab=showLabels&&vis.length<=80;
vis.forEach(m=>{const x=X(m.t),y=Y(m.p),r=3.5+9*Math.sqrt(m.r.eur/maxE),buy=m.r.side==="buy";
const pth=buy?`M${x} ${y+3}l${-r} ${r*1.6}h${2*r}z`:`M${x} ${y-3}l${-r} ${-r*1.6}h${2*r}z`;
const sh=el("path",{d:pth,fill:`var(--${buy?"buy":"sell"})`,"fill-opacity":.85,stroke:"var(--panel)","stroke-width":1},g);
if(!buy&&!m.r.closed)sh.setAttribute("fill-opacity",.45);
sh.style.cursor="pointer";sh.onmousemove=e=>showTip(e,tradeTip(m.r));sh.onmouseleave=()=>tip.style.display="none";
sh.onclick=()=>focusRow(m.r.n);
if(lab){const tx=el("text",{x:x,y:buy?y+r*1.6+15:y-r*1.6-7,"text-anchor":"middle",class:"ax",
fill:buy?"var(--buy)":(m.r.pnl>=0?"var(--win)":"var(--loss)")},g);
tx.textContent=buy?"€"+fmt(m.r.eur,0):(m.r.pnl>=0?"+":"")+"€"+fmt(m.r.pnl,0);tx.style.fill=tx.getAttribute("fill");}});}
// hover crosshair + drag zoom
const cross=el("line",{y1:Tp,y2:Tp+ph,stroke:"var(--muted)","stroke-dasharray":"3 3",visibility:"hidden"},svg);
const brush=el("rect",{y:Tp,height:ph,fill:"var(--sel)",visibility:"hidden"},svg);let drag=null;
const tOf=e=>{const bb=svg.getBoundingClientRect(),x=(e.clientX-bb.left)*W/bb.width;return v0+(Math.min(Math.max(x,L),L+pw)-L)/pw*(v1-v0);};
svg.addEventListener("mousedown",e=>{if(e.target.tagName==="path"&&e.target.style.cursor)return;drag=tOf(e);});
svg.addEventListener("mousemove",e=>{const t=tOf(e);cross.setAttribute("x1",X(t));cross.setAttribute("x2",X(t));cross.setAttribute("visibility","visible");
if(drag!=null){brush.setAttribute("x",X(Math.min(drag,t)));brush.setAttribute("width",Math.abs(X(t)-X(drag)));brush.setAttribute("visibility","visible");}
else if(!(e.target.tagName==="path"&&e.target.style.cursor)){const vals=series.map(s=>{const[a]=slice(s.t,s.v);let i=a;while(i<s.t.length-1&&s.t[i+1]<=t)i++;return`${s.name}: ${yfmt(s.v[i])}`;});
showTip(e,`${stamp(t)}<br>`+vals.join("<br>"));}});
svg.addEventListener("mouseleave",()=>{cross.setAttribute("visibility","hidden");tip.style.display="none";});
window.addEventListener("mouseup",e=>{if(drag==null)return;const t=tOf(e),a=Math.min(drag,t),b=Math.max(drag,t);drag=null;
brush.setAttribute("visibility","hidden");if(b-a>(v1-v0)/200){v0=a;v1=b;draw();}},{once:false});
svg.addEventListener("dblclick",()=>{v0=T0;v1=T1;draw();});}

function holdBands(m){const out=[];let s=null;for(const r of D.trades){if(r.market!==m)continue;
if(r.side==="buy"&&s==null)s=r.time;if(r.side==="sell"&&r.closed&&s!=null){out.push([s,r.time]);s=null;}}
if(s!=null)out.push([s,T1]);return out;}
function draw(){const host=$("#charts");host.innerHTML="";
document.querySelectorAll("#ranges [data-d]").forEach(b=>{const d=+b.dataset.d;b.classList.toggle("on",d?Math.abs((v1-v0)-d*864e5)<864e5&&v1===T1:v0===T0&&v1===T1);});
for(const m of Object.keys(D.prices)){const P=D.prices[m],mk=D.trades.filter(r=>r.market===m).map(r=>({t:r.time,p:r.price,r}));
const nb=mk.filter(x=>x.r.side==="buy"&&x.t>=v0&&x.t<=v1).length,ns=mk.length-mk.filter(x=>x.r.side==="buy").length;
panel(host,{height:380,log:logScale,yfmt:v=>"€"+pfmt(v),band:holdBands(m),markers:mk,
series:[{name:m,t:P.t,v:P.c,color:"var(--price)",w:1.2}],
legend:`<span><b style="color:var(--ink)">${m} price</b></span><span><i style="background:var(--buy);clip-path:polygon(50% 0,100% 100%,0 100%)"></i>buy (size = € spent)</span>
<span><i style="background:var(--sell);clip-path:polygon(0 0,100% 0,50% 100%)"></i>sell (label = profit/loss; faded = partial)</span>
<span><i style="background:var(--hold)"></i>holding</span><span>${mk.filter(x=>x.t>=v0&&x.t<=v1).length} trades in view</span>`});}
const eqS=[{name:"Strategy",t:D.equity.t,v:D.equity.v,color:"var(--eq)",w:1.8}];
if(D.buyHold)eqS.push({name:"Buy & hold",t:D.buyHold.t,v:D.buyHold.v,color:"var(--bh)",dash:"5 4"});
panel(host,{height:240,log:logScale,yfmt:v=>"€"+fmt(v,0),series:eqS,
legend:`<span><i style="background:var(--eq)"></i>strategy equity</span>${D.buyHold?'<span><i style="background:var(--bh)"></i>buy &amp; hold</span>':""}`});
panel(host,{height:120,log:false,yfmt:v=>fmt(v*100,0)+"%",series:[{name:"Invested",t:D.exposure.t,v:D.exposure.v,color:"var(--buy)",fill:true}],
legend:`<span><i style="background:var(--buy)"></i>share of equity in coins</span>`});
renderTable();}

let filt="all";document.querySelectorAll("[data-f]").forEach(b=>b.onclick=()=>{filt=b.dataset.f;
document.querySelectorAll("[data-f]").forEach(x=>x.classList.toggle("on",x===b));renderTable();});
function renderTable(){const rows=D.trades.filter(r=>r.time>=v0&&r.time<=v1&&(filt==="all"||(filt==="buy"||filt==="sell")&&r.side===filt||
filt==="win"&&r.side==="sell"&&r.pnl>0||filt==="loss"&&r.side==="sell"&&r.pnl<=0));
$("#tcount").textContent=`${rows.length} of ${D.trades.length} trades (in the visible range)`;
const cap=rows.slice(0,5000);
$("#tt").innerHTML=`<thead><tr><th>#</th><th class="l">date (UTC)</th><th class="l">market</th><th class="l">side</th><th>price €</th>
<th>amount</th><th>€ value</th><th>fee €</th><th class="l">reason</th><th>P&amp;L €</th><th>P&amp;L %</th><th>held d</th><th>equity after €</th></tr></thead><tbody>`+
cap.map(r=>`<tr class="${r.side}" data-n="${r.n}" data-t="${r.time}"><td>${r.n}</td><td class="l">${r.date}</td><td class="l">${r.market}</td>
<td class="l side">${r.side}${r.side==="sell"&&!r.closed?" (part)":""}</td><td>${pfmt(r.price)}</td><td>${fmt(r.amount,6)}</td><td>${fmt(r.eur)}</td>
<td>${fmt(r.fee)}</td><td class="l">${r.reason}</td><td class="${r.pnl>0?"pos":r.pnl<0?"neg":""}">${r.pnl==null?"":fmt(r.pnl)}</td>
<td class="${r.pnl>0?"pos":r.pnl<0?"neg":""}">${r.pnlPct==null?"":pc(r.pnlPct)}</td><td>${r.heldDays==null?"":fmt(r.heldDays,1)}</td><td>${fmt(r.equityAfter)}</td></tr>`).join("")+
(rows.length>cap.length?`<tr><td colspan="13" class="l muted">… ${rows.length-cap.length} more: zoom in or download the CSV</td></tr>`:"")+"</tbody>";
$("#tt").querySelectorAll("tbody tr[data-t]").forEach(tr=>tr.onclick=()=>zoomTo(+tr.dataset.t));}
function zoomTo(t){const span=Math.max((v1-v0)/8,7*864e5);v0=Math.max(T0,t-span/2);v1=Math.min(T1,t+span/2);draw();scrollTo({top:0,behavior:"smooth"});}
function focusRow(n){const tr=$(`#tt tr[data-n="${n}"]`);if(tr){tr.scrollIntoView({block:"center",behavior:"smooth"});tr.style.background="var(--sel)";setTimeout(()=>tr.style.background="",1500);}}
$("#rt").innerHTML=`<thead><tr><th class="l">market</th><th class="l">opened</th><th class="l">closed</th><th>days</th><th>buys</th><th>sells</th>
<th>avg entry €</th><th>exit €</th><th>invested €</th><th>returned €</th><th>fees €</th><th>P&amp;L €</th><th>P&amp;L %</th></tr></thead><tbody>`+
D.roundTrips.map(p=>`<tr data-t="${p.entry}"><td class="l">${p.market}</td><td class="l">${stamp(p.entry)}</td><td class="l">${p.exit?stamp(p.exit):"open"}</td>
<td>${p.days==null?"":fmt(p.days,1)}</td><td>${p.buys}</td><td>${p.sells}</td><td>${p.avgEntry==null?"":pfmt(p.avgEntry)}</td><td>${p.avgExit==null?"":pfmt(p.avgExit)}</td>
<td>${fmt(p.invested)}</td><td>${fmt(p.returned)}</td><td>${fmt(p.fees)}</td><td class="${p.pnl>0?"pos":"neg"}">${p.exit?fmt(p.pnl):""}</td>
<td class="${p.pnl>0?"pos":"neg"}">${p.exit?pc(p.pnlPct):""}</td></tr>`).join("")+"</tbody>";
$("#rt").querySelectorAll("tbody tr").forEach(tr=>tr.onclick=()=>zoomTo(+tr.dataset.t));
$("#csv").onclick=()=>{const cols=["n","date","market","side","price","amount","eur","fee","liquidity","reason","pnl","pnlPct","heldDays","equityAfter"];
const txt=[cols.join(",")].concat(D.trades.map(r=>cols.map(c=>r[c]==null?"":r[c]).join(","))).join("\n");
const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([txt],{type:"text/csv"}));a.download="trades.csv";a.click();};
let rz;addEventListener("resize",()=>{clearTimeout(rz);rz=setTimeout(draw,150);});draw();
</script></body></html>
"""
