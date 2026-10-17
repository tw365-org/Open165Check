#!/usr/bin/env python3
"""Jev 詐騙判斷評估腳本。

讀取測試集 CSV，對每則訊息呼叫 TypeSafe Jev API（一次請求包含態樣 Choice 與各風險信號 Noul），
輸出二元判斷指標、態樣準確率、門檻掃描與逐筆結果。

用法：
  pip install httpx
  python eval_jev.py --csv jev_fraud_test_set.csv --out results/
  python eval_jev.py --csv jev_fraud_test_set.csv --dry-run      # 只印出請求內容，不呼叫 API

環境變數：
  JEV_API_KEY   TypeSafe API 金鑰（必填，非 dry-run 時）
  JEV_API_URL   預設 https://api.typesafe.ai/v1/systemone
  JEV_MODEL     預設 jev-latest

依據 https://docs.typesafe.ai/api 的正式回應結構解析，無效回應不列入指標。
離線指標與解析測試不需安裝 httpx；真正呼叫 API 時才需要。
"""
import argparse
import asyncio
import csv
import json
import os
import pathlib
import random
import time
import math

try:
    import httpx
except ImportError:
    httpx = None

API_URL = os.environ.get("JEV_API_URL", "https://api.typesafe.ai/v1/systemone")
MODEL = os.environ.get("JEV_MODEL", "jev-latest")
NORMAL = "正常訊息"

CATEGORY_CRITERIA = {
    "釣魚連結": "要求點擊連結、掃描 QR Code 或填寫表單，假冒物流、稅務、電信、銀行通知",
    "假機構服務通知": "假冒電信、銀行、信用卡中心、醫院等機構，以異常、欠費、個資外洩為由要求處理",
    "假客服解除分期": "假冒電商或銀行客服，聲稱誤設分期或重複扣款，要求到 ATM 或網銀操作",
    "假公權力": "假冒檢察官、警察、法院，以涉案、洗錢為由要求保密、匯款或交出帳戶",
    "假投資": "以老師帶單、保證獲利、投資群組等方式誘導入金",
    "假交友": "透過交友或社群關係建立感情後，誘導下載 APP 或一起投資",
    "熟人冒充": "冒充親友或使用新號碼，以急用為由要求借錢或匯款",
    "網購交易陷阱": "假冒購物、賣貨便或包裹通知，誘導付款或私下交易",
    "假買家騙賣家": "假冒買家，以系統鎖定或認證為由要求賣家操作分享畫面或離開平台",
    "假求職": "以高薪兼職為誘餌，要求先付費、先購買物品或提供帳戶資料",
    NORMAL: "正常訊息，不屬於上述任何詐騙態樣",
}

SIGNALS = {
    "demand_link": "這則訊息是否要求點擊連結、開啟網址或掃描 QR Code？",
    "demand_card_info": "這則訊息是否要求輸入卡號、密碼、驗證碼或個人證件資料？",
    "demand_transfer": "這則訊息是否要求匯款、轉帳或提供存款資訊？",
    "off_platform": "這則訊息是否要求離開原平台或改用私訊、其他通訊軟體交易？",
    "demand_app_install": "這則訊息是否要求下載指定 APP？",
    "impersonate_authority": "這則訊息是否冒充政府機關、檢警、銀行、電信或客服？",
    "impersonate_relation": "這則訊息是否冒充親友或家人？",
    "urgency": "這則訊息是否製造急迫感或催促立即行動？",
    "threat": "這則訊息是否以凍結、涉案、影響車籍等後果施壓？",
    "secrecy": "這則訊息是否要求保密或不可告知家人？",
    "guaranteed_return": "這則訊息是否承諾保證獲利或高額回報？",
    "upfront_payment": "這則訊息是否要求先付費、保證金、稅金或購買物品？",
}

# 官方 API reference 已確認。
PROB_KEYS = ("probabilities",)

CATEGORY_QUESTION = "這則訊息最符合下列哪一種詐騙態樣？若不屬於任何詐騙態樣，請選「正常訊息」。"


def build_questions() -> dict:
    questions = {
        "category": {
            "type": "choice",
            "instructions": CATEGORY_QUESTION,
            "criteria": CATEGORY_CRITERIA,
        }
    }
    for key, instruction in SIGNALS.items():
        questions[key] = {"type": "noul", "instructions": instruction}
    return questions


def build_payload(text: str) -> dict:
    return {"model": MODEL, "state": text, "questions": build_questions()}


def parse_answers(resp: dict):
    """嚴格解析官方格式。缺失、非法分數或無效選項皆視為錯誤。"""
    if not isinstance(resp, dict) or not isinstance(resp.get("model"), str) or not resp["model"]:
        raise ValueError("INVALID_RESPONSE")
    answers = resp.get("answers", {})
    if not isinstance(answers, dict):
        raise ValueError("INVALID_RESPONSE")
    cat = answers.get("category", {}) or {}
    if not isinstance(cat, dict):
        raise ValueError("INVALID_RESPONSE")
    choice = cat.get("choice")
    probs = cat.get("probabilities")
    def probability(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 <= v <= 1
    if (cat.get("type") != "choice" or not isinstance(choice, str) or choice not in CATEGORY_CRITERIA
            or not isinstance(probs, dict) or set(probs) != set(CATEGORY_CRITERIA)
            or not all(probability(v) for v in probs.values())
            or abs(sum(probs.values()) - 1) > 0.001 or probs[choice] + 1e-8 < max(probs.values())):
        raise ValueError("INVALID_RESPONSE")
    signals = {}
    for key in SIGNALS:
        answer = answers.get(key)
        if not isinstance(answer, dict) or answer.get("type") != "noul" or not probability(answer.get("noul")):
            raise ValueError("INVALID_RESPONSE")
        signals[key] = answer["noul"]
    usage = resp.get("usage")
    if not isinstance(usage, dict) or not all(type(usage.get(k)) is int and usage[k] >= 0 for k in ("input_tokens", "output_tokens")):
        raise ValueError("INVALID_RESPONSE")
    return choice, probs, signals


def p_scam_of(choice, probs):
    """模型風險分數，並非經校準的真實詐騙機率。"""
    if not probs or NORMAL not in probs:
        raise ValueError("INVALID_RESPONSE")
    return 1.0 - float(probs[NORMAL])


async def call_jev(client, sem, api_key, text):
    payload = build_payload(text)
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    last_err = None
    async with sem:
        for attempt in range(5):
            t0 = time.perf_counter()
            try:
                r = await client.post(API_URL, json=payload, headers=headers, timeout=60)
                latency = (time.perf_counter() - t0) * 1000
                if r.status_code == 429 or r.status_code >= 500:
                    last_err = f"HTTP {r.status_code}"
                    if attempt < 4:
                        await asyncio.sleep(2 ** attempt + random.random())
                    continue
                r.raise_for_status()
                return r.json(), latency, None
            except httpx.HTTPStatusError as e:
                return None, None, f"HTTP {e.response.status_code}"
            except ValueError:
                return None, None, "INVALID_RESPONSE"
            except httpx.HTTPError as e:
                last_err = type(e).__name__
                if attempt < 4:
                    await asyncio.sleep(2 ** attempt)
    return None, None, last_err


def load_rows(path: pathlib.Path, limit=None):
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    return rows[:limit] if limit else rows


def binary_metrics(records, threshold):
    tp = fp = tn = fn = 0
    for r in records:
        if r["p_scam"] is None or r.get("error"):
            continue
        pred = r["p_scam"] >= threshold
        actual = r["label"] == "scam"
        if pred and actual:
            tp += 1
        elif pred and not actual:
            fp += 1
        elif not pred and actual:
            fn += 1
        else:
            tn += 1
    total = tp + fp + tn + fn
    safe_div = lambda a, b: round(a / b, 4) if b else None
    precision = safe_div(tp, tp + fp)
    recall = safe_div(tp, tp + fn)
    f1 = safe_div(2 * tp, 2 * tp + fp + fn)
    return {
        "threshold": threshold,
        "tp": tp, "fp": fp, "tn": tn, "fn": fn,
        "accuracy": safe_div(tp + tn, total),
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "false_positive_rate": safe_div(fp, fp + tn),
    }


def category_metrics(records):
    scam = [r for r in records if r["label"] == "scam" and r["choice"] is not None and not r.get("error")]
    correct = sum(1 for r in scam if r["choice"] == r["category"])
    per = {}
    for r in scam:
        c = r["category"]
        per.setdefault(c, {"n": 0, "correct": 0})
        per[c]["n"] += 1
        per[c]["correct"] += int(r["choice"] == c)
    for c in per:
        per[c]["accuracy"] = round(per[c]["correct"] / per[c]["n"], 4)
    return {
        "scam_category_accuracy": round(correct / len(scam), 4) if scam else None,
        "per_category": per,
    }


def build_report(summary, records):
    lines = ["# Open165Check 詐騙判斷評估報告", ""]
    lines.append(f"- 模型：`{MODEL}`　樣本數：{summary['n_total']}　錯誤數：{summary['n_errors']}")
    lines.append(f"- 平均延遲：{summary['latency_ms_mean']} ms")
    lines.append(f"- 有效樣本：{summary['n_valid']}，成功率：{summary['success_rate']}；指標僅以有效樣本計算。")
    lines.append("")
    b = summary["binary_at_default_threshold"]
    lines.append(f"## 二元判斷（門檻 {b['threshold']}）")
    lines.append("")
    lines.append(f"準確率 {b['accuracy']}，精確率 {b['precision']}，召回率 {b['recall']}，F1 {b['f1']}，誤判率 {b['false_positive_rate']}")
    lines.append("")
    lines.append(f"混淆矩陣：TP {b['tp']} / FP {b['fp']} / TN {b['tn']} / FN {b['fn']}")
    lines.append("")
    lines.append("## 門檻掃描")
    lines.append("")
    lines.append("| 門檻 | 精確率 | 召回率 | F1 | 誤判率 |")
    lines.append("|---|---|---|---|---|")
    for m in summary["threshold_sweep"]:
        lines.append(f"| {m['threshold']} | {m['precision']} | {m['recall']} | {m['f1']} | {m['false_positive_rate']} |")
    lines.append("")
    c = summary["category"]
    lines.append(f"## 態樣準確率（詐騙樣本）：{c['scam_category_accuracy']}")
    lines.append("")
    lines.append("| 態樣 | 筆數 | 正確 | 準確率 |")
    lines.append("|---|---|---|---|")
    for name, v in c["per_category"].items():
        lines.append(f"| {name} | {v['n']} | {v['correct']} | {v['accuracy']} |")
    lines.append("")
    misses = [r for r in records if r["label"] == "scam" and r["p_scam"] is not None and r["p_scam"] < b["threshold"]]
    lines.append(f"## 漏判樣本（詐騙但低於門檻）：{len(misses)} 筆")
    for r in misses:
        lines.append(f"- {r['id']}（{r['category']}）：{r['text'][:60]}")
    return "\n".join(lines)


async def run(args):
    rows = load_rows(pathlib.Path(args.csv), args.limit)
    if not rows:
        raise SystemExit("測試集沒有樣本")

    if args.dry_run:
        print(json.dumps(build_payload(rows[0]["text"]), ensure_ascii=False, indent=2))
        print(f"\n共 {len(rows)} 筆待評估（dry-run，未呼叫 API）")
        return

    api_key = os.environ.get("JEV_API_KEY")
    if httpx is None:
        raise SystemExit("請先安裝 httpx：pip install httpx")
    if not api_key:
        raise SystemExit("缺少 JEV_API_KEY 環境變數")

    sem = asyncio.Semaphore(args.concurrency)
    async with httpx.AsyncClient() as client:
        tasks = [call_jev(client, sem, api_key, r["text"]) for r in rows]
        outputs = await asyncio.gather(*tasks)

    records, latencies, n_errors = [], [], 0
    for row, (resp, latency, err) in zip(rows, outputs):
        rec = {
            "id": row["id"], "label": row["label"], "category": row["category"],
            "variant": row.get("variant", ""), "text": row["text"],
            "choice": None, "p_scam": None, "signals": None, "error": err,
        }
        if resp is None:
            n_errors += 1
        else:
            try:
                choice, probs, signals = parse_answers(resp)
                rec.update(choice=choice, p_scam=p_scam_of(choice, probs), signals=signals,
                           probabilities=probs, actual_model=resp["model"])
                latencies.append(latency)
            except ValueError:
                rec["error"] = "INVALID_RESPONSE"
                n_errors += 1
        records.append(rec)

    thresholds = [round(x / 10, 1) for x in range(3, 10)]
    default_t = args.threshold
    summary = {
        "model": MODEL,
        "n_total": len(records),
        "n_errors": n_errors,
        "n_valid": len(records) - n_errors,
        "success_rate": round((len(records) - n_errors) / len(records), 4) if records else None,
        "actual_models": sorted({r["actual_model"] for r in records if r.get("actual_model")}),
        "latency_ms_mean": round(sum(latencies) / len(latencies), 1) if latencies else None,
        "binary_at_default_threshold": binary_metrics(records, default_t),
        "threshold_sweep": [binary_metrics(records, t) for t in thresholds],
        "category": category_metrics(records),
    }

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (out / f"summary-{stamp}.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / f"report-{stamp}.md").write_text(build_report(summary, records), encoding="utf-8")
    with (out / f"results-{stamp}.jsonl").open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    b = summary["binary_at_default_threshold"]
    print(f"完成：{len(records)} 筆，錯誤 {n_errors} 筆")
    print(f"門檻 {default_t}：準確率 {b['accuracy']} 精確率 {b['precision']} 召回率 {b['recall']} 誤判率 {b['false_positive_rate']}")
    print(f"態樣準確率（詐騙樣本）：{summary['category']['scam_category_accuracy']}")
    print(f"輸出位置：{out.resolve()}")


def main():
    p = argparse.ArgumentParser(description="Jev 詐騙判斷評估")
    p.add_argument("--csv", required=True, help="測試集 CSV 路徑")
    p.add_argument("--out", default="results", help="輸出資料夾")
    p.add_argument("--threshold", type=float, default=0.7, help="詐騙判斷門檻")
    p.add_argument("--concurrency", type=int, default=5, help="同時請求數")
    p.add_argument("--limit", type=int, default=None, help="只評估前 N 筆（測試用）")
    p.add_argument("--dry-run", action="store_true", help="只印出第一筆請求內容")
    args = p.parse_args()
    if not 0 <= args.threshold <= 1 or not math.isfinite(args.threshold):
        p.error("threshold 必須介於 0 與 1")
    if args.concurrency < 1 or (args.limit is not None and args.limit < 1):
        p.error("concurrency 與 limit 必須大於零")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
