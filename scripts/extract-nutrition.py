"""日本食品標準成分表（文科省）の Excel から、献立の栄養計算に使う値だけを JSON に抽出する。

抽出する成分（可食部100gあたり）:
  kcal / たんぱく質 / 脂質 / 炭水化物 / 食物繊維総量 / 食塩相当量
出力: data/nutrition.json  { source, generated_from, foods: [{ id, name, group, kcal, p, f, c, fiber, salt }] }
"""
import json
import os
import re
import sys

import openpyxl

SRC = sys.argv[1] if len(sys.argv) > 1 else "20260327-mxt_kagsei-mext-000029402_02.xlsx"
OUT = os.path.join("data", "nutrition.json")

# 列インデックス（0始まり）。成分識別子の行から確認済み。
COL = {
    "group": 0,   # 食品群
    "id": 1,      # 食品番号
    "name": 3,    # 食品名
    "kcal": 6,    # ENERC_KCAL
    "p": 9,       # PROT-   たんぱく質
    "f": 12,      # FAT-    脂質
    "c": 20,      # CHOCDF- 炭水化物
    "fiber": 18,  # FIB-    食物繊維総量
    "salt": 60,   # NACL_EQ 食塩相当量
}
DATA_START_ROW = 13  # 13行目からデータ


def num(v):
    """成分値を数値に。'(11.3)'=推定値→11.3 / 'Tr'=微量→0 / '-'=未測定→0 / ''→0"""
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("（", "(").replace("）", ")")
    s = s.strip("*").strip()
    if s in ("", "-", "−", "Tr", "(Tr)", "tr"):
        return 0.0
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else 0.0


def main():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    ws = wb["表全体"]
    foods = []
    for row in ws.iter_rows(min_row=DATA_START_ROW, values_only=True):
        fid = row[COL["id"]]
        name = row[COL["name"]]
        if not fid or not name:
            continue
        fid = str(fid).strip()
        if not re.fullmatch(r"\d{5}", fid):
            continue
        foods.append({
            "id": fid,
            "name": re.sub(r"\s+", " ", str(name).replace("　", " ")).strip(),
            "group": str(row[COL["group"]] or "").strip(),
            "kcal": round(num(row[COL["kcal"]]), 1),
            "p": round(num(row[COL["p"]]), 2),
            "f": round(num(row[COL["f"]]), 2),
            "c": round(num(row[COL["c"]]), 2),
            "fiber": round(num(row[COL["fiber"]]), 2),
            "salt": round(num(row[COL["salt"]]), 3),
        })

    os.makedirs("data", exist_ok=True)
    payload = {
        "source": "日本食品標準成分表（文部科学省）",
        "generated_from": os.path.basename(SRC),
        "note": "可食部100gあたり。kcal=エネルギー, p=たんぱく質(g), f=脂質(g), c=炭水化物(g), fiber=食物繊維総量(g), salt=食塩相当量(g)。推定値の括弧は外し、Tr・未測定は0として扱う。",
        "foods": foods,
    }
    with open(OUT, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(foods)} 件を {OUT} に書き出しました（{os.path.getsize(OUT) / 1024:.0f} KB）")


if __name__ == "__main__":
    main()
